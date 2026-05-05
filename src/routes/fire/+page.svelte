<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Doom-fire-style cellular automaton, re-interpreted in ASCII.
	// Inspired by https://codepen.io/jscottsmith/pen/dwZjWK and
	// http://fabiensanglard.net/doom_fire_psx/
	//
	// Each cell holds a heat index (0 = hottest, DEPTH-1 = cold/background).
	// Every frame each cell samples a neighbor (biased toward "below") and
	// inherits its heat + a small random delta. The bottom rows are pinned
	// hot so flames perpetually rise; the mouse cursor is a second hot source.
	//
	// Stylization beyond the original:
	//  - Heat drives BOTH color and density: a glyph ramp goes from ▓▒░· to
	//    empty as cells cool, which only makes sense in a character grid.
	//  - The palette is pre-quantized into DEPTH fixed colors so the runtime
	//    hot path stays bounded.

	const DEPTH = 24;

	// Biased neighbor samples. Matches the original's weighting: mostly
	// "pull from below" with occasional sideways/top draws so the flame
	// licks outward instead of rising in straight columns.
	// Encoded as (dx, dy) pairs.
	const SPREAD: ReadonlyArray<readonly [number, number]> = [
		[0, 1], [0, 1], [0, 1], [0, 1], [0, 1],
		[0, 1], [0, 1], [0, 1], [0, 1], [0, 1],
		[-1, 0], [-1, 0],
		[1, 0], [1, 0],
		[0, -1],
	];

	const STOPS: Array<[number, [number, number, number]]> = [
		[0.0, [230, 230, 250]], // lavender — white-hot core
		[0.1, [255, 255, 0]],   // yellow
		[0.3, [255, 215, 0]],   // gold
		[0.5, [255, 105, 180]], // hotpink
		[0.6, [255, 99, 71]],   // tomato
		[0.8, [72, 61, 139]],   // darkslateblue
		[1.0, [24, 16, 32]],    // near-black
	];

	function sampleGradient(t: number): string {
		for (let i = 0; i < STOPS.length - 1; i++) {
			const [t0, c0] = STOPS[i];
			const [t1, c1] = STOPS[i + 1];
			if (t <= t1) {
				const u = (t - t0) / (t1 - t0);
				const r = Math.round(c0[0] + (c1[0] - c0[0]) * u);
				const g = Math.round(c0[1] + (c1[1] - c0[1]) * u);
				const b = Math.round(c0[2] + (c1[2] - c0[2]) * u);
				const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
				return `#${hex}`;
			}
		}
		return '#181020';
	}

	const COLORS: string[] = Array.from({ length: DEPTH }, (_, i) =>
		sampleGradient(i / (DEPTH - 1))
	);

	// Density ramp: hot cells are dense, cold cells fade to space.
	// All BMP code units so Uint16Array char storage is safe.
	const RAMP = '@#%&8WM▓▒░*+=:-. ';
	const RAMP_CHARS: number[] = Array.from({ length: DEPTH }, (_, i) => {
		const t = i / (DEPTH - 1);
		const idx = Math.min(RAMP.length - 1, Math.floor(t * RAMP.length));
		return RAMP.charCodeAt(idx);
	});

	let heat: Uint8Array | null = null;
	let next: Uint8Array | null = null;
	let hCols = 0;
	let hRows = 0;
	let frames = 0;
	let mouseSeen = false;

	function effect(c: AsciiApi) {
		const cols = c.cols;
		const rows = c.rows;

		if (!heat || hCols !== cols || hRows !== rows) {
			heat = new Uint8Array(cols * rows);
			next = new Uint8Array(cols * rows);
			heat.fill(DEPTH - 1);
			// Bottom two rows pinned hot (the classic fire source).
			for (let y = rows - 2; y < rows; y++) {
				for (let x = 0; x < cols; x++) heat[y * cols + x] = 0;
			}
			hCols = cols;
			hRows = rows;
			frames = 0;
		}

		// Mouse hot source. Before the user moves the mouse, orbit a
		// pointer around the center so the effect self-demos.
		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;
		let px: number, py: number;
		if (mouseSeen) {
			px = c.mouse.x;
			py = c.mouse.y;
		} else {
			const z = frames / 40;
			const sx = cols * 0.35;
			const sy = rows * 0.35;
			px = Math.floor(cols / 2 + Math.sin(z) * sx);
			py = Math.floor(rows / 2 + Math.cos(z * 1.3) * sy);
		}
		if (px >= 0 && py >= 0 && px < cols && py < rows) {
			// Stamp a small hot blob so the cursor leaves a satisfying trail.
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = px + dx;
					const ny = py + dy;
					if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
						heat[ny * cols + nx] = 0;
					}
				}
			}
		}

		// Resolve palette indices once per frame.
		const fgIdx = new Array<number>(DEPTH);
		for (let i = 0; i < DEPTH; i++) fgIdx[i] = c.color(COLORS[i]);
		const bgIdx = c.color('#080410');

		// Draw current state.
		for (let y = 0; y < rows; y++) {
			const row = y * cols;
			for (let x = 0; x < cols; x++) {
				const h = heat[row + x];
				c.setI(x, y, RAMP_CHARS[h], fgIdx[h], bgIdx);
			}
		}

		// Advance automaton into `next`.
		const nxt = next!;
		for (let y = 0; y < rows; y++) {
			const row = y * cols;
			for (let x = 0; x < cols; x++) {
				const [dx, dy] = SPREAD[(Math.random() * SPREAD.length) | 0];
				const sx = x + dx;
				const sy = y + dy;
				const self = heat[row + x];
				let h: number;
				if (sx >= 0 && sy >= 0 && sx < cols && sy < rows) {
					const src = heat[sy * cols + sx];
					if (src < self) {
						// Inherit neighbor's heat plus a little noise. The
						// occasional -1 lets flames climb past their source.
						h = src + ((Math.random() * 6) | 0) - 1;
					} else {
						h = self + 1;
					}
				} else {
					h = self + 1;
				}
				if (h < 0) h = 0;
				else if (h > DEPTH - 1) h = DEPTH - 1;
				nxt[row + x] = h;
			}
		}
		// Re-pin source rows so they never cool.
		for (let y = rows - 2; y < rows; y++) {
			for (let x = 0; x < cols; x++) nxt[y * cols + x] = 0;
		}

		// Swap buffers.
		const tmp = heat;
		heat = nxt;
		next = tmp;

		frames++;

		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
