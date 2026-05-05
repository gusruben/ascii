<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Line segments in a 6x6 source period. Coords are cell-grid corners in (x, y):
	// a '_' at cell (row r, col c) is the segment (c, r+1) → (c+1, r+1),
	// a '\' is (c, r) → (c+1, r+1), a '/' is (c, r+1) → (c+1, r).
	const BASE_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
		[2, 0, 3, 1], // \ (0,2)
		[3, 1, 5, 1], // __ (0,3-4)
		[5, 1, 6, 2], // \ (1,5)
		[2, 2, 3, 1], // / (1,2)
		[0, 2, 2, 2], // __ (1,0-1)
		[2, 2, 3, 3], // \ (2,2)
		[2, 4, 3, 3], // / (3,2)
		[0, 4, 2, 4], // __ (3,0-1)
		[2, 4, 3, 5], // \ (4,2)
		[3, 5, 5, 5], // __ (4,3-4)
		[5, 5, 6, 4], // / (4,5)
		[2, 6, 3, 5], // / (5,2)
	];

	const CH_UNDER = 95; // _
	const CH_SLASH = 47; // /
	const CH_BACK = 92; // \
	const CH_PIPE = 124; // |

	// Pick char based on line direction AND the sample's sub-cell y position.
	// `_` is only emitted when the warped curve is close to a cell boundary
	// (integer y) — at mid-cell y, a near-horizontal curve is bridged with
	// `\`/`/` so it connects to `_` on neighboring rows. Near-vertical → `|`.
	function pickChar(dx: number, dy: number, y: number): number {
		const ax = Math.abs(dx);
		const ay = Math.abs(dy);
		if (ax === 0 && ay === 0) return 32;
		if (ax < ay * 0.35) return CH_PIPE;
		if (ay < ax * 0.5) {
			const yFrac = y - Math.floor(y);
			const yDist = Math.min(yFrac, 1 - yFrac);
			if (yDist < 0.28) return CH_UNDER;
		}
		if (dx === 0) return dy > 0 ? CH_BACK : CH_SLASH;
		return dx * dy > 0 ? CH_BACK : CH_SLASH;
	}

	function effect(c: AsciiApi) {
		const { cols, rows, mouse, cellAspect } = c;
		const mx = mouse.fx;
		const my = mouse.fy;
		const R = Math.min(cols, rows * cellAspect) * 0.35;
		const R2 = R * R;
		const invPower = 1 / 2.2;

		c.clear();

		function fwd(sx: number, sy: number): [number, number] {
			const dsx = sx - mx;
			const dsy = (sy - my) * cellAspect;
			const ds2 = dsx * dsx + dsy * dsy;
			if (ds2 >= R2 || ds2 === 0) return [sx, sy];
			const ds = Math.sqrt(ds2);
			const screenD = R * Math.pow(ds / R, invPower);
			const k = screenD / ds;
			return [mx + dsx * k, my + (dsy * k) / cellAspect];
		}

		const bufX = new Float64Array(128);
		const bufY = new Float64Array(128);
		const claimed = new Uint8Array(cols * rows);

		for (let ty = -6; ty < rows + 6; ty += 6) {
			for (let tx = -6; tx < cols + 6; tx += 6) {
				for (let e = 0; e < BASE_EDGES.length; e++) {
					const [x0, y0, x1, y1] = BASE_EDGES[e];
					const sx0 = tx + x0;
					const sy0 = ty + y0;
					const sx1 = tx + x1;
					const sy1 = ty + y1;

					const N = 96;
					for (let i = 0; i < N; i++) {
						const t = (i + 0.5) / N;
						const [wx, wy] = fwd(sx0 + (sx1 - sx0) * t, sy0 + (sy1 - sy0) * t);
						bufX[i] = wx;
						bufY[i] = wy;
					}

					// Walk between consecutive samples with DDA so no cell is skipped
					// even when the warp stretches a source unit across many cells.
					let prevCX = -999;
					let prevCY = -999;
					let prevCh = 0;
					for (let i = 0; i < N - 1; i++) {
						const ax = bufX[i];
						const ay = bufY[i];
						const bx = bufX[i + 1];
						const by = bufY[i + 1];
						const segDx = bx - ax;
						const segDy = by - ay;
						// Use the sub-segment's own direction (no smoothing) so transitions
						// get accurate local slope and bridge chars are placed correctly.
						const len = Math.max(Math.abs(segDx), Math.abs(segDy));
						const walkSteps = Math.max(1, Math.ceil(len * 2));
						for (let j = 0; j < walkSteps; j++) {
							const t = (j + 0.5) / walkSteps;
							const px = ax + segDx * t;
							const py = ay + segDy * t;
							const ch = pickChar(segDx, segDy, py);
							const cellY = ch === CH_UNDER ? Math.floor(py - 0.5) : Math.floor(py);
							const cellX = Math.floor(px);
							if (cellX < 0 || cellX >= cols || cellY < 0 || cellY >= rows) continue;
							if (cellX === prevCX && cellY === prevCY) continue;
							// Within-edge adjacency dedup: prevent this edge alone from
							// making a 2-thick line (same char, side-by-side).
							if (ch === prevCh) {
								if (
									(ch === CH_BACK || ch === CH_SLASH) &&
									cellY === prevCY &&
									Math.abs(cellX - prevCX) === 1
								) {
									prevCX = cellX;
									prevCY = cellY;
									continue;
								}
								if (
									(ch === CH_UNDER || ch === CH_PIPE) &&
									cellX === prevCX &&
									Math.abs(cellY - prevCY) === 1 &&
									ch === CH_UNDER
								) {
									prevCX = cellX;
									prevCY = cellY;
									continue;
								}
								if (
									ch === CH_PIPE &&
									cellY === prevCY &&
									Math.abs(cellX - prevCX) === 1
								) {
									prevCX = cellX;
									prevCY = cellY;
									continue;
								}
							}
							const idx = cellY * cols + cellX;
							if (claimed[idx]) {
								prevCX = cellX;
								prevCY = cellY;
								prevCh = ch;
								continue;
							}
							claimed[idx] = 1;
							c.setI(cellX, cellY, ch, 0, 1);
							prevCX = cellX;
							prevCY = cellY;
							prevCh = ch;
						}
					}
				}
			}
		}
	}
</script>

<AsciiCanvas {effect} selectable />
