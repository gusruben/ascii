<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	let showLabels = $state(false);

	// 6×6×6 color cube → xterm index 16 + 36r + 6g + b.
	function cubeRgb(r: number, g: number, b: number): [number, number, number] {
		const conv = (v: number) => (v === 0 ? 0 : 55 + 40 * v);
		return [conv(r), conv(g), conv(b)];
	}

	// Laid out as 3 columns × 2 rows of slices. Each slice fixes red; axes are g (x) and b (y).
	// The 6 slices together form an 18-wide × 12-tall grid of color cells. One full tile
	// fills the canvas; tiles repeat seamlessly as the view pans toward the top-left.
	const GRID_W = 18;
	const GRID_H = 12;
	// Time to traverse one full tile (i.e. cross the whole page). Larger = slower.
	const PAN_SECS_X = 40;
	const PAN_SECS_Y = 60;

	function effect(c: AsciiApi) {
		c.clear();

		// One tile spans the entire canvas. Speed expressed as "tiles per second".
		const offX = (c.elapsed / PAN_SECS_X) * c.cols;
		const offY = (c.elapsed / PAN_SECS_Y) * c.rows;

		// World x of grid line k. Because round(k * cols / GRID_W) returns exactly
		// n*cols at every tile boundary (k = n*GRID_W), tiles seam perfectly.
		const worldColEdge = (k: number) => Math.round((k * c.cols) / GRID_W);
		const worldRowEdge = (k: number) => Math.round((k * c.rows) / GRID_H);
		const colEdge = (k: number) => Math.floor(worldColEdge(k) - offX);
		const rowEdge = (k: number) => Math.floor(worldRowEdge(k) - offY);

		// Visible grid range. Use loose bounds and clip via fillRect/skip-empty.
		const gx0 = Math.floor((offX * GRID_W) / c.cols) - 1;
		const gx1 = Math.floor(((offX + c.cols) * GRID_W) / c.cols) + 1;
		const gy0 = Math.floor((offY * GRID_H) / c.rows) - 1;
		const gy1 = Math.floor(((offY + c.rows) * GRID_H) / c.rows) + 1;

		const mod = (n: number, m: number) => ((n % m) + m) % m;

		for (let gy = gy0; gy <= gy1; gy++) {
			const y0Raw = rowEdge(gy);
			const y1Raw = rowEdge(gy + 1);
			const y0 = Math.max(0, y0Raw);
			const y1 = Math.min(c.rows, y1Raw);
			const h = y1 - y0;
			if (h <= 0) continue;

			const cy = mod(gy, GRID_H);
			const sliceRow = Math.floor(cy / 6); // 0..1
			const b = cy % 6;

			for (let gx = gx0; gx <= gx1; gx++) {
				const x0Raw = colEdge(gx);
				const x1Raw = colEdge(gx + 1);
				const x0 = Math.max(0, x0Raw);
				const x1 = Math.min(c.cols, x1Raw);
				const w = x1 - x0;
				if (w <= 0) continue;

				const cx = mod(gx, GRID_W);
				const sliceCol = Math.floor(cx / 6); // 0..2
				const g = cx % 6;
				const r = sliceRow * 3 + sliceCol; // 0..5

				const [rr, gg, bb] = cubeRgb(r, g, b);
				const bgc = c.rgb(rr, gg, bb);
				const luma = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
				const fgc = luma > 0.5 ? '#000000' : '#ffffff';

				c.fillRect(x0, y0, w, h, ' ', fgc, bgc);

				if (showLabels) {
					const idx = 16 + 36 * r + 6 * g + b;
					const label = String(idx);
					const tileW = x1Raw - x0Raw;
					const tileH = y1Raw - y0Raw;
					if (tileW >= label.length + 1 && tileH >= 1) {
						const tx = x0Raw + Math.floor((tileW - label.length) / 2);
						const ty = y0Raw + Math.floor(tileH / 2);
						if (tx >= 0 && tx + label.length <= c.cols && ty >= 0 && ty < c.rows) {
							c.text(tx, ty, label, fgc, bgc);
						}
					}
				}
			}
		}
	}
</script>

<svelte:window onclick={() => (showLabels = !showLabels)} />

<AsciiCanvas {effect} />
