<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// ──────────────────────────────────────────────────────────────
	// Tile model.
	//
	// The hex pattern is a 6×6 corner-grid repeat unit. Coords are corner-grid
	// (integer) positions, not cell positions. Each edge connects two corners;
	// rendering then picks `_`, `/`, or `\` based on the edge's direction:
	//
	//   dy == 0        ->  _   (horizontal)
	//   dx ==  dy != 0 ->  \   (45° down-right)
	//   dx == -dy != 0 ->  /   (45° down-left)
	//
	// These are the only allowed slopes: a "perfect" line is one that lays
	// down exactly one char per cell along the path, with no doubling and no
	// skips. The tile below has 12 edges; each edge is already one of the
	// three allowed orientations, so the un-warped tile renders perfectly.
	const BASE_EDGES: ReadonlyArray<readonly [number, number, number, number]> = [
		[2, 0, 3, 1], // \
		[3, 1, 5, 1], // __
		[5, 1, 6, 2], // \
		[2, 2, 3, 1], // /
		[0, 2, 2, 2], // __
		[2, 2, 3, 3], // \
		[2, 4, 3, 3], // /
		[0, 4, 2, 4], // __
		[2, 4, 3, 5], // \
		[3, 5, 5, 5], // __
		[5, 5, 6, 4], // /
		[2, 6, 3, 5] // /
	];

	const TILE_W = 6;
	const TILE_H = 6;

	const CH_UNDER = 95; // _
	const CH_SLASH = 47; // /
	const CH_BACK = 92; // \

	const T_UNDER = 0;
	const T_BACK = 1;
	const T_SLASH = 2;

	// Smoothed cursor — lags the real cursor with exponential decay. Module
	// scope so state persists across frames; runes don't apply here since
	// nothing outside this closure reads it.
	let smX = 0;
	let smY = 0;
	let smInit = false;

	function effect(c: AsciiApi) {
		const { cols, rows, mouse, cellAspect, dt } = c;
		c.clear();

		if (!smInit) {
			smX = mouse.fx;
			smY = mouse.fy;
			smInit = true;
		}
		// ~1.6 /s → ~half-life 0.43s. Feels slow-follow.
		const kFollow = 1 - Math.exp(-1.6 * dt);
		smX += (mouse.fx - smX) * kFollow;
		smY += (mouse.fy - smY) * kFollow;

		// ── Mound warp. ─────────────────────────────────────────────
		// Radial factor k(t) = 1 + STRENGTH·(1 - t²)⁵ where t = ds/R. With a
		// larger R and a higher exponent, the core profile stays close to
		// the previous shape but the outer quarter of the radius extends into
		// a long, very faint halo that fades in almost imperceptibly before
		// the mound proper starts to take hold.
		const mx = smX;
		const my = smY;
		// Floor keeps the mound visible on tiny viewports (e.g. the iframe on /),
		// where min-dim * 0.4 alone would only cover a few tiles.
		const R = Math.max(Math.min(cols, rows * cellAspect) * 0.4, 20);
		const R2 = R * R;
		const STRENGTH = 1.1;

		function warp(sx: number, sy: number): [number, number] {
			const dsx = sx - mx;
			const dsy = (sy - my) * cellAspect;
			const ds2 = dsx * dsx + dsy * dsy;
			if (ds2 >= R2) return [sx, sy];
			const u = 1 - ds2 / R2;
			const u2 = u * u;
			const bump = u2 * u2 * u;
			const k = 1 + STRENGTH * bump;
			return [mx + dsx * k, my + (dsy * k) / cellAspect];
		}

		// ── Build point+edge graph over the visible region. ─────────
		// Every tile emits 12 edges; endpoints on tile boundaries are shared
		// with neighbors. Dedup by absolute corner coord so each lattice
		// point has exactly one index (and exactly one warped position).
		const PAD = TILE_W;
		const minTX = Math.floor(-PAD / TILE_W) * TILE_W;
		const maxTX = Math.ceil((cols + PAD) / TILE_W) * TILE_W;
		const minTY = Math.floor(-PAD / TILE_H) * TILE_H;
		const maxTY = Math.ceil((rows + PAD) / TILE_H) * TILE_H;

		const pointIdx = new Map<number, number>();
		const pointX: number[] = [];
		const pointY: number[] = [];

		function getPoint(x: number, y: number): number {
			// Coords fit comfortably in ±10000; pack into one number.
			const key = (x + 10000) * 100000 + (y + 10000);
			let idx = pointIdx.get(key);
			if (idx === undefined) {
				idx = pointX.length;
				pointIdx.set(key, idx);
				pointX.push(x);
				pointY.push(y);
			}
			return idx;
		}

		const edgeA: number[] = [];
		const edgeB: number[] = [];
		const edgeT: number[] = [];
		const edgeKey = new Set<number>();

		for (let ty = minTY; ty <= maxTY; ty += TILE_H) {
			for (let tx = minTX; tx <= maxTX; tx += TILE_W) {
				for (let e = 0; e < BASE_EDGES.length; e++) {
					const [x0, y0, x1, y1] = BASE_EDGES[e];
					const a = getPoint(tx + x0, ty + y0);
					const b = getPoint(tx + x1, ty + y1);
					const lo = a < b ? a : b;
					const hi = a < b ? b : a;
					const k = lo * 1000000 + hi;
					if (edgeKey.has(k)) continue;
					edgeKey.add(k);
					const dx = x1 - x0;
					const dy = y1 - y0;
					const t = dy === 0 ? T_UNDER : dx * dy > 0 ? T_BACK : T_SLASH;
					edgeA.push(a);
					edgeB.push(b);
					edgeT.push(t);
				}
			}
		}

		const N = pointX.length;
		const M = edgeA.length;

		// ── Warp every point independently. ─────────────────────────
		const px = new Float64Array(N);
		const py = new Float64Array(N);
		for (let i = 0; i < N; i++) {
			const [x, y] = warp(pointX[i], pointY[i]);
			px[i] = x;
			py[i] = y;
		}

		// ── Solve: relax positions so every edge is axis-aligned or 45°. ──
		// Each edge type is an equality constraint between its endpoints:
		//   _  :  y_a == y_b                   (horizontal rail)
		//   \  :  (x - y)_a == (x - y)_b       (down-right rail)
		//   /  :  (x + y)_a == (x + y)_b       (down-left rail)
		// Project each endpoint onto the shared value using a minimum-norm
		// shift (orthogonal to the constraint). Gauss-Seidel over all edges
		// converges quickly because each point sits on a short chain per type.
		const ITERS = 48;
		for (let iter = 0; iter < ITERS; iter++) {
			for (let e = 0; e < M; e++) {
				const a = edgeA[e];
				const b = edgeB[e];
				const t = edgeT[e];
				if (t === T_UNDER) {
					const avg = (py[a] + py[b]) * 0.5;
					py[a] = avg;
					py[b] = avg;
				} else if (t === T_BACK) {
					const ca = px[a] - py[a];
					const cb = px[b] - py[b];
					const avg = (ca + cb) * 0.5;
					const da = (ca - avg) * 0.5;
					px[a] -= da;
					py[a] += da;
					const db = (cb - avg) * 0.5;
					px[b] -= db;
					py[b] += db;
				} else {
					const ca = px[a] + py[a];
					const cb = px[b] + py[b];
					const avg = (ca + cb) * 0.5;
					const da = (ca - avg) * 0.5;
					px[a] -= da;
					py[a] -= da;
					const db = (cb - avg) * 0.5;
					px[b] -= db;
					py[b] -= db;
				}
			}
		}

		// ── Snap each point to an integer corner. ──────────────────
		const ix = new Int32Array(N);
		const iy = new Int32Array(N);
		for (let i = 0; i < N; i++) {
			ix[i] = Math.round(px[i]);
			iy[i] = Math.round(py[i]);
		}

		// ── Render each edge as a run of chars, one per cell. ───────
		// `_` at cell (cx, cy) covers corner segment (cx, cy+1)→(cx+1, cy+1),
		// `\` at (cx, cy) covers (cx, cy)→(cx+1, cy+1),
		// `/` at (cx, cy) covers (cx+1, cy)→(cx, cy+1).
		// Each edge walks its endpoints in integer steps, so the laid-down
		// chars tile exactly with no gaps or overlaps.
		const claimed = new Uint8Array(cols * rows);
		function put(cx: number, cy: number, code: number) {
			if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return;
			const k = cy * cols + cx;
			if (claimed[k]) return;
			claimed[k] = 1;
			c.setI(cx, cy, code, 0, 1);
		}

		for (let e = 0; e < M; e++) {
			const a = edgeA[e];
			const b = edgeB[e];
			const t = edgeT[e];
			const xa = ix[a];
			const ya = iy[a];
			const xb = ix[b];
			const yb = iy[b];

			if (t === T_UNDER) {
				const y = Math.round((py[a] + py[b]) * 0.5);
				const x0 = xa < xb ? xa : xb;
				const x1 = xa < xb ? xb : xa;
				const row = y - 1;
				for (let x = x0; x < x1; x++) put(x, row, CH_UNDER);
			} else if (t === T_BACK) {
				// (cx+i, cy+i) walking from upper-left corner.
				const sx = xa < xb ? xa : xb;
				const sy = ya < yb ? ya : yb;
				const L = Math.min(Math.abs(xb - xa), Math.abs(yb - ya));
				for (let i = 0; i < L; i++) put(sx + i, sy + i, CH_BACK);
			} else {
				// (cx+i, cy-1-i) walking from lower-left corner.
				const sx = xa < xb ? xa : xb;
				const sy = xa < xb ? ya : yb; // y paired with the smaller x is the larger y
				const L = Math.min(Math.abs(xb - xa), Math.abs(yb - ya));
				for (let i = 0; i < L; i++) put(sx + i, sy - 1 - i, CH_SLASH);
			}
		}
	}
</script>

<AsciiCanvas {effect} selectable />
