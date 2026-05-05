<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { buildWideAtlas, matchWide } from '$lib/ascii/wideAtlas';

	// Wide-atlas streamlines. A curl-noise streamfunction ψ(x, y, t) is
	// evaluated at every cell corner (cheap), then bilinearly interpolated
	// across the cell's 8×16 sub-cell grid. A sub-cell's bit is set when
	// the interpolated ψ sits inside a thin band around an integer multiple
	// of `STRIPE` — those bands are the streamlines of the flow.
	//
	// The resulting per-cell 8×16 mask captures whatever curve segment of a
	// streamline passes through that cell. `matchWide` picks the closest
	// glyph from the wide atlas (~1500 unique Unicode shapes after dedupe:
	// box drawing, geometric, math, Greek, Cyrillic, Braille, dingbats).
	// Smooth flowing curves come out as box-drawing arcs, math operators,
	// dingbat brackets — far richer than the 16-glyph marching-squares
	// lookup the basic flow demo uses.
	//
	// Cost per frame is dominated by:
	//   - ψ at (W+1)·(H+1) cell corners (3 trig per corner)
	//   - mask build at full sub-cell resolution (128 sub-cells × cheap
	//     bilinear + threshold per cell)
	//   - matchWide per cell (~50 candidates × ~5 ops with early-out =
	//     ~250 ops per match thanks to bucket index + SAD early-out)
	// Roughly 25-35 ms per frame at 200×60.

	function psiBase(x: number, y: number, t: number): number {
		return (
			Math.sin(x * 0.09 + t * 0.45) +
			Math.cos(y * 0.11 - t * 0.3) +
			0.7 * Math.sin((x + y) * 0.05 + t * 0.55)
		);
	}

	function mouseContrib(dx: number, dy: number): number {
		const r2 = dx * dx + dy * dy;
		if (r2 > 900) return 0;
		return 6 * Math.exp(-r2 / 200);
	}

	let psiCorners: Float32Array | null = null;
	let cornerW = 0;
	let cornerH = 0;
	let maskBuffer: Uint32Array | null = null;
	let mbW = 0;
	let mbH = 0;

	let mouseSeen = false;
	let frames = 0;
	let atlasReady = false;

	const STRIPE = 0.55;
	const BAND = 0.13; // half-width of the streamline band (in ψ units)

	function effect(c: AsciiApi) {
		if (!atlasReady) {
			buildWideAtlas();
			atlasReady = true;
		}

		const W = c.cols;
		const H = c.rows;
		const aspect = c.cellAspect;

		const cW = W + 1;
		const cH = H + 1;
		if (!psiCorners || cornerW !== cW || cornerH !== cH) {
			psiCorners = new Float32Array(cW * cH);
			cornerW = cW;
			cornerH = cH;
		}
		if (!maskBuffer || mbW !== W || mbH !== H) {
			maskBuffer = new Uint32Array(W * H * 4);
			mbW = W;
			mbH = H;
		}

		const t = c.elapsed;
		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;
		let mx: number;
		let my: number;
		if (mouseSeen) {
			mx = c.mouse.fx;
			my = c.mouse.fy;
		} else {
			const z = frames / 100;
			mx = W * 0.5 + Math.sin(z) * W * 0.35;
			my = H * 0.5 + Math.cos(z * 1.3) * H * 0.35;
		}
		const myV = my * aspect;

		const psi = psiCorners!;
		for (let j = 0; j < cH; j++) {
			const yy = j * aspect;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				psi[rowOff + i] = psiBase(i, yy, t) + mouseContrib(i - mx, yy - myV);
			}
		}

		const buf = maskBuffer!;
		const invStripe = 1 / STRIPE;

		for (let y = 0; y < H; y++) {
			const r0 = y * cW;
			const r1 = (y + 1) * cW;
			for (let x = 0; x < W; x++) {
				const tl = psi[r0 + x];
				const tr = psi[r0 + x + 1];
				const bl = psi[r1 + x];
				const br = psi[r1 + x + 1];

				let m0 = 0;
				let m1 = 0;
				let m2 = 0;
				let m3 = 0;

				// Bilinear factoring: at vertical depth v, left/right edges
				// interpolate to (left, right). Within a row, ψ varies
				// linearly in u → 1 mul + 1 add per sub-cell. The two
				// per-row mults+adds (left, right) amortize over 8 sub-cells.
				for (let osy = 0; osy < 16; osy++) {
					const v = (osy + 0.5) / 16;
					const left = tl * (1 - v) + bl * v;
					const right = tr * (1 - v) + br * v;
					const dpsi = (right - left) / 8;
					let p = left + 0.5 * dpsi;
					for (let osx = 0; osx < 8; osx++) {
						// streamline band test: |ψ - nearest integer multiple of STRIPE| < BAND
						let m = p * invStripe;
						m = m - Math.floor(m); // fractional part in [0, 1)
						const distFromInt = Math.min(m, 1 - m); // distance to nearest integer
						if (distFromInt * STRIPE < BAND) {
							const i = osy * 8 + osx;
							if (i < 32) m0 |= 1 << i;
							else if (i < 64) m1 |= 1 << (i - 32);
							else if (i < 96) m2 |= 1 << (i - 64);
							else m3 |= 1 << (i - 96);
						}
						p += dpsi;
					}
				}

				const base = (y * W + x) * 4;
				buf[base] = m0;
				buf[base + 1] = m1;
				buf[base + 2] = m2;
				buf[base + 3] = m3;
			}
		}

		const atlas = buildWideAtlas();
		const codes = atlas.codes;
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const base = (y * W + x) * 4;
				const idx = matchWide(buf[base], buf[base + 1], buf[base + 2], buf[base + 3], atlas);
				c.setI(x, y, codes[idx], 0, 1);
			}
		}

		frames++;
		c.text(0, 0, `${Math.round(c.fps)} FPS · ${atlas.N} glyphs`);
	}
</script>

<AsciiCanvas {effect} selectable={false} />
