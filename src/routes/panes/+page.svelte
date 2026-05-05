<script lang="ts">
	// Vertical panes that parallax at independent speeds as the wheel scrolls.
	// Each pane also has an internal "texture" pattern that scrolls at its
	// own speed, so the content visibly slides inside the pane window as the
	// pane itself drifts past.
	import { onMount } from 'svelte';
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { BRAILLE_BASE, BRAILLE_BITS } from '$lib/ascii/constants';

	const COLOR_FILL_CHARS = ['▓', '▒', '░', '█', '▚', '▞'];

	const PALETTE = [
		{ fg: '#f2dcb3', bg: '#4a3622' },
		{ fg: '#ffc2a8', bg: '#4a1f1f' },
		{ fg: '#b8d8e8', bg: '#1c3448' },
		{ fg: '#d4c2ee', bg: '#2a1e48' },
		{ fg: '#b0e8c2', bg: '#1c3828' },
		{ fg: '#f0e2c0', bg: '#4a3a1a' },
		{ fg: '#eeacca', bg: '#3a1a2a' },
		{ fg: '#d2d2ee', bg: '#1f2a40' },
		{ fg: '#e2c8a0', bg: '#2a2014' },
		{ fg: '#a0cae8', bg: '#14253a' }
	];

	// Internal-pattern types. Each is a function of (px, py) — the pane's
	// local texture coordinates. We shift `py` by a per-pane offset that
	// scales with scroll to get the "content sliding inside the window" look.
	type PatternType =
		| 'checker' // 2-wide blocky checkerboard, ▀/▄ half-cell smoothing
		| 'checkerFine' // 1×1 high-density checkerboard, half-cell smoothing
		| 'hstripe' // horizontal bands using 1/3-cell unicode steps
		| 'braille' // 2×4 braille-dot pattern with 4× vertical res
		| 'dots' // sparse grid of dots
		| 'ramp' // gradient ░▒▓█ cycling through
		| 'solid';
	const PATTERN_TYPES: PatternType[] = [
		'checker',
		'checkerFine',
		'hstripe',
		// 'braille', // disabled — even with JetBrains Mono loaded, the
		//             browser's per-glyph font substitution produces
		//             mismatched advance widths that shift row content
		'dots',
		'ramp',
		'solid'
	];

	const SOLID_CHARS = ['░', '▒', '▓', '█', '=', '|', '·', '+'];
	const RAMP = '░▒▓█▓▒';
	const SPACE = 32;
	const BLOCK_FULL = 0x2588; // █
	const BLOCK_SHADE_LIGHT = 0x2591; // ░
	const BLOCK_SHADE_MED = 0x2592; // ▒
	const BLOCK_SHADE_DARK = 0x2593; // ▓
	const CH_DASH = 0x2500; // ─
	const CH_UPPER_EIGHTH = 0x2594; // ▔ (top-eighth bar)
	const CH_LOWER_EIGHTH = 0x2581; // ▁
	const CH_UPPER_HALF = 0x2580; // ▀
	const CH_LOWER_HALF = 0x2584; // ▄
	const CH_DOT = 0x00b7; // ·

	function patternCharCode(
		type: PatternType,
		px: number,
		pyRaw: number,
		solidCode: number
	): number {
		// `pyRaw` is the fractional row (pane-local y + scroll offset).
		// Integer-jumpy patterns round it; sub-cell patterns use it directly.
		const py = Math.round(pyRaw);
		switch (type) {
			case 'checker': {
				// 2-wide blocks with half-cell vertical smoothing via ▀/▄.
				// Each screen cell's top and bottom halves are sampled
				// independently from the texture so scrolling by 0.5 cells
				// produces a visible step instead of jumping a whole cell.
				const bx = px >> 1;
				const topPy = Math.round(pyRaw - 0.25);
				const botPy = Math.round(pyRaw + 0.25);
				const topOn = ((bx + topPy) & 1) === 0;
				const botOn = ((bx + botPy) & 1) === 0;
				if (topOn && botOn) return BLOCK_FULL;
				if (topOn) return CH_UPPER_HALF;
				if (botOn) return CH_LOWER_HALF;
				return SPACE;
			}
			case 'checkerFine': {
				// 1×1 checkerboard with same half-cell smoothing.
				const topPy = Math.round(pyRaw - 0.25);
				const botPy = Math.round(pyRaw + 0.25);
				const topOn = ((px + topPy) & 1) === 0;
				const botOn = ((px + botPy) & 1) === 0;
				if (topOn && botOn) return BLOCK_FULL;
				if (topOn) return CH_UPPER_HALF;
				if (botOn) return CH_LOWER_HALF;
				return SPACE;
			}
			case 'braille': {
				// 2×4 braille dots → 4× vertical sub-cell resolution.
				// Separable grid: X-mask depends only on X, Y-mask only on Y.
				// This way vertical scroll slides the pattern strictly
				// vertically (no diagonal slide).
				const subY = Math.round(pyRaw * 4);
				let mask = 0;
				for (let sy = 0; sy < 4; sy++) {
					const Y = subY + sy;
					if ((((Y % 3) + 3) % 3) !== 0) continue;
					for (let sx = 0; sx < 2; sx++) {
						const X = px * 2 + sx;
						if (((X % 2) + 2) % 2 === 0) {
							mask |= BRAILLE_BITS[sy * 2 + sx];
						}
					}
				}
				return BRAILLE_BASE + mask;
			}
			case 'hstripe': {
				// Lines at continuous y = 3k. Cell at continuous y = pyRaw.
				// Find signed distance `delta` from nearest line, mod 3,
				// in [-1.5, 1.5). Render the line inside the cell whose
				// center is within 0.5 of it, choosing ▔/─/▁ by sub-cell y.
				let m = pyRaw % 3;
				if (m < 0) m += 3;
				const delta = m < 1.5 ? m : m - 3;
				if (delta > -0.5 && delta <= 0.5) {
					// delta > 0: line sits above cell center → ▔
					// delta < 0: line sits below cell center → ▁
					if (delta > 1 / 6) return CH_UPPER_EIGHTH;
					if (delta > -1 / 6) return CH_DASH;
					return CH_LOWER_EIGHTH;
				}
				return SPACE;
			}
			case 'dots': {
				const a = ((px % 3) + 3) % 3;
				const b = ((py % 2) + 2) % 2;
				return a === 0 && b === 0 ? CH_DOT : SPACE;
			}
			case 'ramp': {
				const i = (((py % RAMP.length) + RAMP.length) % RAMP.length) | 0;
				return RAMP.charCodeAt(i);
			}
			case 'solid':
			default:
				return solidCode;
		}
	}

	type Pane = {
		slotId: number;
		h: number;
		speed: number;
		phase: number;
		z: number;
		// Regenerated each cycle.
		x: number;
		w: number;
		char: string; // color-mode fill
		bwCharCode: number; // used by 'solid' pattern
		pattern: PatternType;
		innerSpeed: number;
		fg: string;
		bg: string;
		cycle: number;
	};

	type Mode = 'bw' | 'color';
	let mode: Mode = 'bw';

	let panes: Pane[] = [];
	let paneCols = 0;
	let paneRows = 0;

	let scrollPos = 0;
	let scrollVel = 0;
	let eIntensity = 0;

	function mulberry32(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function regen(p: Pane, cycle: number, cols: number) {
		const rand = mulberry32(((p.slotId * 0x9e3779b1) ^ (cycle * 0x85ebca6b)) | 0);
		p.w = 3 + Math.floor(rand() * 14);
		p.x = Math.floor(rand() * (cols + p.w)) - Math.floor(p.w / 2);
		p.char = COLOR_FILL_CHARS[Math.floor(rand() * COLOR_FILL_CHARS.length)];
		p.bwCharCode = SOLID_CHARS[Math.floor(rand() * SOLID_CHARS.length)].charCodeAt(0);
		p.pattern = PATTERN_TYPES[Math.floor(rand() * PATTERN_TYPES.length)];
		// Internal scroll speed as a fraction of the pane's own motion.
		// Random sign too, so some textures drift against the pane's travel.
		p.innerSpeed = (rand() * 2 - 1) * 1.6;
		const col = PALETTE[Math.floor(rand() * PALETTE.length)];
		p.fg = col.fg;
		p.bg = col.bg;
		p.cycle = cycle;
	}

	function initPanes(cols: number, rows: number) {
		const rand = mulberry32(0x9e3779);
		const list: Pane[] = [];
		const N = Math.max(20, Math.floor(cols * 0.22));
		for (let i = 0; i < N; i++) {
			const h = Math.max(3, Math.floor(rows * (0.18 + rand() * 0.55)));
			const speed = 0.25 + rand() * 1.9;
			const period = rows + h + 4;
			const phase = rand() * period;
			const z = rand();
			const p: Pane = {
				slotId: i,
				h,
				speed,
				phase,
				z,
				x: 0,
				w: 0,
				char: ' ',
				bwCharCode: SPACE,
				pattern: 'solid',
				innerSpeed: 0,
				fg: '#fff',
				bg: '#000',
				cycle: Number.NaN
			};
			regen(p, 0, cols);
			list.push(p);
		}
		list.sort((a, b) => a.z - b.z);
		panes = list;
		paneCols = cols;
		paneRows = rows;
	}

	onMount(() => {
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			let dy = e.deltaY;
			if (e.deltaMode === 1) dy *= 16;
			else if (e.deltaMode === 2) dy *= window.innerHeight;
			scrollVel += dy * WHEEL_GAIN;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === ' ' || e.code === 'Space') {
				e.preventDefault();
				mode = mode === 'bw' ? 'color' : 'bw';
			}
		};
		window.addEventListener('wheel', onWheel, { passive: false });
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('wheel', onWheel);
			window.removeEventListener('keydown', onKey);
		};
	});

	const SHADOW_DX = 2;
	const SHADOW_DY = 2;
	const SHADOW_BG = '#000000';
	const PX_PER_CELL = 22;

	const WHEEL_GAIN = 0.9;
	const FRICTION = 1.2;
	const TITLE_BASE_ES = 5;
	const TITLE_MAX_EXTRA_ES = 60;
	// eIntensity integrates |scrollVel| over time and decays. Small gain so
	// a single wheel tick adds only ~1 e; sustained fast scroll builds up.
	const E_GAIN = 0.012;
	const E_DECAY = 0.7;
	const TITLE_COLOR = '#ff2d2d';

	function effect(c: AsciiApi) {
		if (paneCols !== c.cols || paneRows !== c.rows || panes.length === 0) {
			initPanes(c.cols, c.rows);
		}

		const dt = Math.min(c.dt || 1 / 60, 1 / 30);
		const decay = Math.exp(-dt * FRICTION);
		scrollPos += (scrollVel * (1 - decay)) / FRICTION;
		scrollVel *= decay;
		if (Math.abs(scrollVel) < 0.5) scrollVel = 0;

		const scrollCells = scrollPos / PX_PER_CELL;

		c.clear();

		const rowsN = c.rows;
		const colsN = c.cols;
		const bw = mode === 'bw';

		for (let i = 0; i < panes.length; i++) {
			const p = panes[i];
			const period = rowsN + p.h + 4;
			const shifted = p.phase - scrollCells * p.speed + p.h + 2;
			const cycle = Math.floor(shifted / period);
			if (cycle !== p.cycle) regen(p, cycle, colsN);
			const wrapped = shifted - cycle * period;
			const yFloat = wrapped - p.h - 2;
			const y = Math.round(yFloat);

			if (bw) {
				// Plain-black shadow.
				c.fillRect(p.x + SHADOW_DX, y + SHADOW_DY, p.w, p.h, ' ');
				// Pattern coord is continuous in both scroll and pane position:
				// using `yFloat` (not integer `y`) prevents the pattern from
				// phase-jumping by ~2 cells whenever the pane's rounded row
				// flips. `innerYFloat` is fractional too for sub-cell patterns.
				const innerYFloat = scrollCells * p.innerSpeed;
				const patternOffset = innerYFloat - yFloat;
				const solidCode = p.bwCharCode;
				const type = p.pattern;
				const x0 = Math.max(0, p.x);
				const x1 = Math.min(colsN, p.x + p.w);
				const y0 = Math.max(0, y);
				const y1 = Math.min(rowsN, y + p.h);
				for (let gy = y0; gy < y1; gy++) {
					const pyRaw = gy + patternOffset;
					for (let gx = x0; gx < x1; gx++) {
						const px = gx - p.x;
						const code = patternCharCode(type, px, pyRaw, solidCode);
						c.set(gx, gy, String.fromCharCode(code));
					}
				}
			} else {
				c.fillRect(p.x + SHADOW_DX, y + SHADOW_DY, p.w, p.h, ' ', SHADOW_BG, SHADOW_BG);
				c.fillRect(p.x, y, p.w, p.h, p.char, p.fg, p.bg);
			}
		}

		eIntensity += Math.abs(scrollVel) * dt * E_GAIN;
		eIntensity *= Math.exp(-dt * E_DECAY);
		const extraEs = Math.min(TITLE_MAX_EXTRA_ES, Math.floor(eIntensity));
		const title = 'wh' + 'e'.repeat(TITLE_BASE_ES + extraEs);
		c.textCentered(colsN >> 1, rowsN >> 1, title, TITLE_COLOR);
	}
</script>

<AsciiCanvas {effect} />
