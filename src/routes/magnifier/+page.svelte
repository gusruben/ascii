<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { getGlyphAtlas, matchMask, MASK_WORDS, GW, GH } from '$lib/ascii/glyphShape';
	import { stripComments } from '$lib/quineSource';
	import selfSourceRaw from './+page.svelte?raw';

	// Self-reading magnifier (quine). The page renders its own source code
	// (comments stripped) at two scales:
	//
	//   - Outside the cursor's lens: a shape-matched thumbnail. For each
	//     output cell, an 8×16 target mask is built by sampling the
	//     corresponding sub-cell of each source character the cell
	//     covers, then `matchMask` picks the closest atlas glyph. The
	//     atlas now includes block-element halves (▀▄▌▐), quadrants
	//     (▘▝▖▗▙▟▚▞), shaded fills (░▒▓█), and the eighth blocks (▁▂▃▅▆▇
	//     ▏▎▍▋▊▉) — giving the matcher clean primitives for full / half /
	//     partial cells that ASCII alone resolves poorly. The thumbnail
	//     is computed once per resize and cached.
	//
	//   - Inside the lens: 1:1 verbatim source. Each output cell shows
	//     the source character at the cursor-anchored position.
	//
	// The lens edge uses marching-squares-style glyphs so the boundary
	// reads as a smooth ring, not a jagged step.

	const selfSource = stripComments(selfSourceRaw);

	const COLS = 80;

	let virtualCodes: Uint16Array | null = null;
	let baseLines: string[] | null = null;
	let vW = 0;
	let vH = 0;

	function layoutBase(text: string): string[] {
		const expanded = text.replace(/\t/g, '  ');
		const rawLines = expanded.split('\n');
		const lines: string[] = [];
		for (const ln of rawLines) {
			let s = ln;
			while (s.length > COLS) {
				lines.push(s.slice(0, COLS).padEnd(COLS, ' '));
				s = s.slice(COLS);
			}
			lines.push(s.padEnd(COLS, ' '));
		}
		return lines;
	}

	function buildVirtual() {
		if (!baseLines) baseLines = layoutBase(selfSource);
		const bL = baseLines;
		vW = COLS;
		vH = bL.length;
		virtualCodes = new Uint16Array(vW * vH);
		for (let y = 0; y < vH; y++) {
			const line = bL[y];
			for (let x = 0; x < vW; x++) {
				virtualCodes[y * vW + x] = line.charCodeAt(x);
			}
		}
	}

	let thumbnailCodes: Uint16Array | null = null;
	let thumbW = 0;
	let thumbH = 0;

	function buildThumbnail(W: number, H: number) {
		thumbW = W;
		thumbH = H;
		thumbnailCodes = new Uint16Array(W * H);
		if (!virtualCodes) return;

		const Kx = vW / W;
		const Ky = vH / H;
		const atlas = getGlyphAtlas();
		const target = new Uint32Array(MASK_WORDS);
		const masksFlat = atlas.masksFlat;

		// Reverse lookup: char code → atlas index. Atlas now includes block
		// glyphs at codes ≥ 0x2580, so size the table to cover them.
		const codeMax = 0x2600;
		const codeToIdx = new Int16Array(codeMax);
		codeToIdx.fill(-1);
		for (let i = 0; i < atlas.codes.length; i++) {
			const cp = atlas.codes[i];
			if (cp < codeMax) codeToIdx[cp] = i;
		}

		// Pre-resolve mask offset per virtual cell so the inner loop is a
		// single typed-array read, not a code→idx→offset chain.
		const maskOffs = new Int32Array(vW * vH);
		const codes = virtualCodes;
		for (let i = 0; i < vW * vH; i++) {
			const cp = codes[i];
			const idx = cp < codeMax ? codeToIdx[cp] : -1;
			maskOffs[i] = (idx >= 0 ? idx : 0) * MASK_WORDS;
		}

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				target[0] = 0;
				target[1] = 0;
				target[2] = 0;
				target[3] = 0;

				for (let osy = 0; osy < GH; osy++) {
					const supY = Ky * (y * GH + osy + 0.5);
					const srcCharY = Math.floor(supY / GH);
					const subY = Math.floor(supY) - srcCharY * GH;
					let iy = srcCharY % vH;
					if (iy < 0) iy += vH;
					const rowOff = iy * vW;

					for (let osx = 0; osx < GW; osx++) {
						const supX = Kx * (x * GW + osx + 0.5);
						const srcCharX = Math.floor(supX / GW);
						const subX = Math.floor(supX) - srcCharX * GW;
						let ix = srcCharX % vW;
						if (ix < 0) ix += vW;
						const off = maskOffs[rowOff + ix];
						const subIdx = subY * GW + subX;
						const bit = (masksFlat[off + (subIdx >>> 5)] >>> (subIdx & 31)) & 1;
						if (bit) {
							const i = osy * GW + osx;
							target[i >>> 5] |= 1 << (i & 31);
						}
					}
				}

				const matchedIdx = matchMask(target, atlas, 1);
				thumbnailCodes![y * W + x] = atlas.codes[matchedIdx];
			}
		}
	}

	const BEZEL = new Uint16Array([
		32, 96, 39, 34, 44, 40, 47, 70, 46, 92, 41, 63, 95, 76, 74, 32
	]);

	let mouseSeen = false;
	let frames = 0;

	function effect(c: AsciiApi) {
		const W = c.cols;
		const H = c.rows;
		const aspect = c.cellAspect;

		if (!virtualCodes) buildVirtual();
		if (!thumbnailCodes || thumbW !== W || thumbH !== H) buildThumbnail(W, H);

		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;
		let mx: number;
		let my: number;
		if (mouseSeen) {
			mx = c.mouse.fx;
			my = c.mouse.fy;
		} else {
			const z = frames / 130;
			mx = W * 0.5 + Math.sin(z) * W * 0.35;
			my = H * 0.5 + Math.cos(z * 1.27) * H * 0.32;
		}

		const Kx = vW / W;
		const Ky = vH / H;
		const smx = mx * Kx;
		const smy = my * Ky;

		const R = Math.max(5, Math.min(W, H * aspect) * 0.13);
		const Rsq = R * R;

		const codes = virtualCodes!;
		const thumb = thumbnailCodes!;

		for (let y = 0; y < H; y++) {
			const yV0 = (y - my) * aspect;
			const yV1 = (y + 1 - my) * aspect;
			const yV0sq = yV0 * yV0;
			const yV1sq = yV1 * yV1;
			for (let x = 0; x < W; x++) {
				const xV0 = x - mx;
				const xV1 = x + 1 - mx;
				const xV0sq = xV0 * xV0;
				const xV1sq = xV1 * xV1;
				let mask = 0;
				if (xV0sq + yV0sq < Rsq) mask |= 1;
				if (xV1sq + yV0sq < Rsq) mask |= 2;
				if (xV0sq + yV1sq < Rsq) mask |= 4;
				if (xV1sq + yV1sq < Rsq) mask |= 8;

				if (mask === 15) {
					const sx = smx + (x - mx);
					const sy = smy + (y - my);
					let ix = Math.round(sx) % vW;
					let iy = Math.round(sy) % vH;
					if (ix < 0) ix += vW;
					if (iy < 0) iy += vH;
					c.setI(x, y, codes[iy * vW + ix], 0, 1);
				} else if (mask === 0) {
					c.setI(x, y, thumb[y * W + x], 0, 1);
				} else {
					c.setI(x, y, BEZEL[mask], 0, 1);
				}
			}
		}

		frames++;
		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} selectable={false} />
