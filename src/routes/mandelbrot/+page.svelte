<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import {
		GAREA,
		MASK_WORDS,
		getBilinearWeights,
		getGlyphAtlas,
		logAtlasSamples,
		matchMask,
		type Mask
	} from '$lib/ascii/glyphShape';

	let cx = -0.5;
	let cy = 0;
	let scale = 1.5; // half-width of view in complex plane
	let maxIter = 80;

	let mouseDown = false;
	let dragging = false;
	let dragPrevX = 0;
	let dragPrevY = 0;

	let wheelAccum = 0;
	let wheelX = 0;
	let wheelY = 0;

	// Touch state — 1 finger pans, 2 fingers pinch-zoom (and pan via midpoint).
	// Handlers accumulate deltas in CLIENT px; `draw` consumes them and converts
	// to complex-plane units using the pre's bounding rect.
	//
	// Touches are tracked by `identifier` (stable per-finger across events).
	// Earlier versions kept a single "previous position" var, which got stale
	// when fingers lifted asynchronously or events were missed — manifesting
	// as huge pan/zoom jumps on the second gesture. Identifier-keyed tracking
	// makes every per-finger delta unambiguous regardless of event ordering.
	const touchPos = new Map<number, { x: number; y: number }>();
	let touchPanDX = 0;
	let touchPanDY = 0;
	let pinchFactor = 1;
	let pinchMidX = 0;
	let pinchMidY = 0;
	let pinchPending = false;

// Corner-sampled smooth iteration grid, (W+1) × (H+1). Negative = inside set.
	let corners = new Float32Array(0);
	let cornerW = 0;
	let cornerH = 0;

	// Render modes. The first four use a marching-squares corner mask
	//   bit1=TL, 2=TR, 4=BL, 8=BR
	// and a 16-entry character lookup. The two `shape*` modes use a
	// different algorithm — a sub-cell glyph-shape matcher (see comment
	// block above the shape render branch below).
	type Mode = 'quad' | 'ascii' | 'color' | 'art' | 'shape' | 'shape-color';
	let mode: Mode = 'shape-color';

	// Scratch buffer reused across cells for the shape modes — the matcher
	// only reads from it after we fully populate it for each cell, so a
	// single allocation is safe and avoids ~12k allocations per frame.
	const shapeTarget: Mask = new Uint32Array(MASK_WORDS);
	let atlasLogged = false;

	// Lazy-populated color palettes for `color` mode. 12-hue cycle.
	// Each iso-ring gets both a bright fg (the letter) and a very dim bg (the
	// ring's ambient glow) — char shape encodes LOCAL structure, color encodes
	// GLOBAL structure (iteration band). Bounded at ~26 palette entries total
	// so the renderer's color-interning Map stays small.
	const BAND_COUNT = 12;
	const bandFg: string[] = [];
	const bandBg: string[] = [];
	// Warm cream for cells touching the set — provides a stable silhouette that
	// reads as "the subject" against the shifting spectrum rings.
	const SET_FG = '#ffeec8';
	const SET_BG_CORE = '#1a1408'; // dim warm backing for fully-interior cells

	// Mode "art": strict 16-color ANSI palette, painted like a classic
	// mandelbrot art poster. Each iteration band gets a COLORED BG (the "stripe"
	// filling the ring) and a complementary BRIGHT FG for its letters — so the
	// rings read as filled color fields rather than letters-on-black. Bayer 4×4
	// dithering at band boundaries gives painterly cross-hatched transitions.
	// The set itself is solid black — a clean silhouette in the middle of the
	// color field, same as most iconic mandelbrot art.
	const ANSI_BLACK       = '#000000';
	const ANSI_RED         = '#aa0000';
	const ANSI_GREEN       = '#00aa00';
	const ANSI_YELLOW      = '#aa5500';
	const ANSI_BLUE        = '#0000aa';
	const ANSI_MAGENTA     = '#aa00aa';
	const ANSI_CYAN        = '#00aaaa';
	const ANSI_BR_RED      = '#ff5555';
	const ANSI_BR_GREEN    = '#55ff55';
	const ANSI_BR_YELLOW   = '#ffff55';
	const ANSI_BR_BLUE     = '#5555ff';
	const ANSI_BR_MAGENTA  = '#ff55ff';
	const ANSI_BR_CYAN     = '#55ffff';
	const ANSI_BR_WHITE    = '#ffffff';

	// 12-stop hue cycle through ANSI: each hue appears twice in a row,
	// dim-then-bright, so adjacent bands in the same family "pulse" light.
	// Cycle goes blue→cyan→green→yellow→red→magenta→blue (CCW round the wheel).
	const ART_BG = [
		ANSI_BLUE,     ANSI_BR_BLUE,
		ANSI_CYAN,     ANSI_BR_CYAN,
		ANSI_GREEN,    ANSI_BR_GREEN,
		ANSI_YELLOW,   ANSI_BR_YELLOW,
		ANSI_RED,      ANSI_BR_RED,
		ANSI_MAGENTA,  ANSI_BR_MAGENTA,
	];
	// For FG always pick the bright complement of the BG hue — gives every
	// band a high-contrast "neon" read regardless of whether BG is dim or
	// bright, so the letter shapes stay legible across the whole spectrum.
	//   BLUE / BR_BLUE      →  BR_YELLOW
	//   CYAN / BR_CYAN      →  BR_RED
	//   GREEN / BR_GREEN    →  BR_MAGENTA
	//   YELLOW / BR_YELLOW  →  BR_BLUE
	//   RED / BR_RED        →  BR_CYAN
	//   MAGENTA / BR_MAGENTA→  BR_GREEN
	const ART_FG = [
		ANSI_BR_YELLOW,  ANSI_BR_YELLOW,
		ANSI_BR_RED,     ANSI_BR_RED,
		ANSI_BR_MAGENTA, ANSI_BR_MAGENTA,
		ANSI_BR_BLUE,    ANSI_BR_BLUE,
		ANSI_BR_CYAN,    ANSI_BR_CYAN,
		ANSI_BR_GREEN,   ANSI_BR_GREEN,
	];
	const ART_LEN = 12;

	// Bayer 4×4 threshold matrix, values 0..15. Threshold = (v + 0.5) / 16.
	// Gives 16 stable dither levels per cell that produce a nice cross-hatch
	// pattern rather than white-noise speckle.
	const BAYER4 = [
		 0,  8,  2, 10,
		12,  4, 14,  6,
		 3, 11,  1,  9,
		15,  7, 13,  5,
	];

	// Mode "quad": Unicode quarter-blocks — ink fills exactly the corners that
	// are inside the set / above the iso threshold. Same palette for both layers
	// since quarter-blocks natively represent filled shapes AND contour crossings.
	const QUAD_SET = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█';
	const QUAD_ISO = QUAD_SET;

	// Mode "ascii": plain keyboard characters chosen so that the character's
	// own ink shape matches the cell's fractal shape — what a human ASCII artist
	// would pick. Each index below is the 4-bit corner mask; the char has ink in
	// roughly those same quadrants.
	//   1 TL only        → `   (tick at top-left)
	//   2 TR only        → '   (tick at top-right)
	//   3 TL+TR top      → "   (double tick along top)
	//   4 BL only        → ,   (mark at bottom-left)
	//   5 TL+BL left     → [   (bracket hugging left edge)
	//   6 TR+BL anti-diag→ /   (diagonal BL↔TR)
	//   7 TL+TR+BL       → 7   (top bar + diagonal down to BL — literally this)
	//   8 BR only        → .   (small mark at bottom)
	//   9 TL+BR main-diag→ \   (diagonal TL↔BR)
	//  10 TR+BR right    → ]   (bracket hugging right edge)
	//  11 TL+TR+BR       → 9   (top loop + tail down the right — mirror of 7)
	//  12 BL+BR bottom   → _   (underscore along bottom)
	//  13 TL+BL+BR       → L   (left vertical + bottom horizontal)
	//  14 TR+BL+BR       → J   (right vertical + bottom curling left)
	//  15 full           → #
	const ASCII_SET = [
		' ', '`', "'", '"', ',', '[', '/', '7',
		'.', '\\', ']', '9', '_', 'L', 'J', '#',
	];
	// For iso-contour cells, the MEANING of the mask is "corners above threshold",
	// i.e. a line is passing through the cell. Instead of drawing the line itself
	// (which would want slashes/pipes/hyphens), pick a LETTER or DIGIT whose
	// ink falls in the same quadrants as the above-threshold corners — the half
	// of the cell on the "above" side of the contour. This fills the rings with
	// text instead of rule characters.
	//   1 TL wedge   → r   (stem + small hook, TL-heavy)
	//   2 TR wedge   → '   (top-right tick)
	//   3 top band   → n   (arch hugging the top)
	//   4 BL wedge   → ,   (bottom-left mark)
	//   5 left band  → (   (left-curving bracket)
	//   6 anti-diag  → z   (anti-diagonal zigzag)
	//   7 cut BR     → F   (top bar + left stem)
	//   8 BR wedge   → .   (bottom mark)
	//   9 main-diag  → s   (S-curve with main-diag flow)
	//  10 right band → )   (right-curving bracket)
	//  11 cut BL     → ?   (top curl + right stem + bottom dot)
	//  12 bottom band→ u   (arch hugging the bottom)
	//  13 cut TR     → b   (left ascender + bottom loop)
	//  14 cut TL     → d   (right ascender + bottom loop)
	//  15 full above → ' ' (no line passes — cell sits cleanly in one band)
	const ASCII_ISO = [
		' ', 'r', "'", 'n', ',', '(', 'z', 'F',
		'.', 's', ')', '?', 'u', 'b', 'd', ' ',
	];

	$effect(() => {
		const down = (e: MouseEvent) => {
			if (e.button === 0) {
				mouseDown = true;
				dragging = false;
			}
		};
		const up = (e: MouseEvent) => {
			if (e.button === 0) mouseDown = false;
		};
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			wheelAccum += e.deltaY;
			wheelX = e.clientX;
			wheelY = e.clientY;
		};
		// Disable browser pinch-zoom / pan-scroll over the canvas so our
		// touch handlers receive the raw gestures. Setting touch-action on the
		// pre alone isn't enough — iOS Safari hijacks 2-finger gestures unless
		// the touched ancestor *and* the document also opt out. We set it on
		// the wrap (covers the full viewport via `fixed inset-0`) and on the
		// document element. We also preventDefault Safari's proprietary
		// `gesturestart`/`gesturechange` events, which is what actually stops
		// it from taking over the pinch and starving our touchmove listener.
		const pre = document.querySelector('pre') as HTMLElement | null;
		const wrap = pre?.parentElement as HTMLElement | null;
		const docEl = document.documentElement;
		const prevTouchActionPre = pre?.style.touchAction ?? '';
		const prevTouchActionWrap = wrap?.style.touchAction ?? '';
		const prevTouchActionDoc = docEl.style.touchAction;
		if (pre) pre.style.touchAction = 'none';
		if (wrap) wrap.style.touchAction = 'none';
		docEl.style.touchAction = 'none';

		const gesture = (e: Event) => e.preventDefault();

		const touchStart = (e: TouchEvent) => {
			e.preventDefault();
			for (let i = 0; i < e.changedTouches.length; i++) {
				const t = e.changedTouches[i];
				touchPos.set(t.identifier, { x: t.clientX, y: t.clientY });
			}
		};
		const touchMove = (e: TouchEvent) => {
			e.preventDefault();
			const touches = e.touches;
			if (touches.length === 1) {
				const t = touches[0];
				const prev = touchPos.get(t.identifier);
				const dx = prev ? t.clientX - prev.x : 0;
				const dy = prev ? t.clientY - prev.y : 0;
				if (prev) {
					touchPanDX += dx;
					touchPanDY += dy;
				}
				touchPos.set(t.identifier, { x: t.clientX, y: t.clientY });
			} else if (touches.length >= 2) {
				const t0 = touches[0];
				const t1 = touches[1];
				const prev0 = touchPos.get(t0.identifier);
				const prev1 = touchPos.get(t1.identifier);
				if (prev0 && prev1) {
					const prevDist = Math.hypot(prev0.x - prev1.x, prev0.y - prev1.y);
					const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
					const prevMidX = (prev0.x + prev1.x) / 2;
					const prevMidY = (prev0.y + prev1.y) / 2;
					const midX = (t0.clientX + t1.clientX) / 2;
					const midY = (t0.clientY + t1.clientY) / 2;
					if (prevDist > 0 && dist > 0) {
						pinchFactor *= prevDist / dist;
						touchPanDX += midX - prevMidX;
						touchPanDY += midY - prevMidY;
						pinchMidX = midX;
						pinchMidY = midY;
						pinchPending = true;
					}
				}
				touchPos.set(t0.identifier, { x: t0.clientX, y: t0.clientY });
				touchPos.set(t1.identifier, { x: t1.clientX, y: t1.clientY });
			}
		};
		const touchEnd = (e: TouchEvent) => {
			for (let i = 0; i < e.changedTouches.length; i++) {
				touchPos.delete(e.changedTouches[i].identifier);
			}
		};

		window.addEventListener('mousedown', down);
		window.addEventListener('mouseup', up);
		window.addEventListener('wheel', wheel, { passive: false });
		window.addEventListener('touchstart', touchStart, { passive: false });
		window.addEventListener('touchmove', touchMove, { passive: false });
		window.addEventListener('touchend', touchEnd);
		window.addEventListener('touchcancel', touchEnd);
		window.addEventListener('gesturestart', gesture as EventListener);
		window.addEventListener('gesturechange', gesture as EventListener);
		window.addEventListener('gestureend', gesture as EventListener);
		return () => {
			if (pre) pre.style.touchAction = prevTouchActionPre;
			if (wrap) wrap.style.touchAction = prevTouchActionWrap;
			docEl.style.touchAction = prevTouchActionDoc;
			window.removeEventListener('mousedown', down);
			window.removeEventListener('mouseup', up);
			window.removeEventListener('wheel', wheel);
			window.removeEventListener('touchstart', touchStart);
			window.removeEventListener('touchmove', touchMove);
			window.removeEventListener('touchend', touchEnd);
			window.removeEventListener('touchcancel', touchEnd);
			window.removeEventListener('gesturestart', gesture as EventListener);
			window.removeEventListener('gesturechange', gesture as EventListener);
			window.removeEventListener('gestureend', gesture as EventListener);
		};
	});

	function draw(c: AsciiApi) {
		const W = c.cols;
		const H = c.rows;
		const cW = W + 1;
		const cH = H + 1;
		if (cW !== cornerW || cH !== cornerH) {
			cornerW = cW;
			cornerH = cH;
			corners = new Float32Array(cW * cH);
		}

		// Keyboard controls
		const dt = c.dt;
		const panSpeed = 0.8; // fraction of view per second
		if (c.keys.isDown('ArrowLeft') || c.keys.isDown('a')) cx -= scale * panSpeed * dt;
		if (c.keys.isDown('ArrowRight') || c.keys.isDown('d')) cx += scale * panSpeed * dt;
		if (c.keys.isDown('ArrowUp') || c.keys.isDown('w')) cy -= scale * panSpeed * dt;
		if (c.keys.isDown('ArrowDown') || c.keys.isDown('s')) cy += scale * panSpeed * dt;

		const zoomRate = 2.0; // per second
		if (c.keys.isDown('=') || c.keys.isDown('+') || c.keys.isDown('e')) {
			scale *= Math.pow(1 / zoomRate, dt);
		}
		if (c.keys.isDown('-') || c.keys.isDown('_') || c.keys.isDown('q')) {
			scale *= Math.pow(zoomRate, dt);
		}
		if (c.keys.justPressed('r') || c.keys.justPressed('R')) {
			cx = -0.5;
			cy = 0;
			scale = 1.5;
		}
		if (c.keys.justPressed(' ')) {
			mode =
				mode === 'quad' ? 'ascii'
				: mode === 'ascii' ? 'color'
				: mode === 'color' ? 'art'
				: mode === 'art' ? 'shape'
				: mode === 'shape' ? 'shape-color'
				: 'quad';
		}

		// Mouse drag panning — uses fractional cell coords (mouse.fx/fy) so drag
		// is incremental rather than snapped to whole-cell jumps. We track the
		// previous fractional position ourselves; the runtime only exposes
		// integer mouse.px/py.
		const aspect = c.cellAspect;
		const dxPerCol = (2 * scale) / W;
		const dyPerRow = dxPerCol * aspect;
		if (mouseDown) {
			if (dragging) {
				cx -= (c.mouse.fx - dragPrevX) * dxPerCol;
				cy -= (c.mouse.fy - dragPrevY) * dyPerRow;
			}
			dragPrevX = c.mouse.fx;
			dragPrevY = c.mouse.fy;
			dragging = true;
		} else {
			dragging = false;
		}

		// Touch pan + pinch zoom. Convert accumulated client-px deltas using the
		// pre's bounding rect — complex-per-px is uniform on screen because the
		// runtime's dyPerRow already bakes in cellAspect (cellH/cellW).
		if (touchPanDX !== 0 || touchPanDY !== 0 || pinchPending) {
			const preEl = document.querySelector('pre') as HTMLElement | null;
			const rect = preEl?.getBoundingClientRect();
			if (rect && rect.width > 0) {
				const cpp = (2 * scale) / rect.width;
				cx -= touchPanDX * cpp;
				cy -= touchPanDY * cpp;
				if (pinchPending && pinchFactor !== 1) {
					const ox = pinchMidX - (rect.left + rect.width / 2);
					const oy = pinchMidY - (rect.top + rect.height / 2);
					const wx = cx + ox * cpp;
					const wy = cy + oy * cpp;
					scale *= pinchFactor;
					const ncpp = (2 * scale) / rect.width;
					cx = wx - ox * ncpp;
					cy = wy - oy * ncpp;
				}
			}
			touchPanDX = 0;
			touchPanDY = 0;
			pinchFactor = 1;
			pinchPending = false;
		}

		// Wheel zoom centered on cursor
		if (wheelAccum !== 0) {
			const factor = Math.pow(1.0015, wheelAccum);
			// Convert wheel client coords to cell coords — approximate using mouse state
			const mx = c.mouse.x;
			const my = c.mouse.y;
			const inside = mx >= 0 && mx < W && my >= 0 && my < H;
			if (inside) {
				const wx = cx + (mx - W / 2) * dxPerCol;
				const wy = cy + (my - H / 2) * dyPerRow;
				scale *= factor;
				const ndxPerCol = (2 * scale) / W;
				const ndyPerRow = ndxPerCol * aspect;
				cx = wx - (mx - W / 2) * ndxPerCol;
				cy = wy - (my - H / 2) * ndyPerRow;
			} else {
				scale *= factor;
			}
			wheelAccum = 0;
		}

		// Adaptive iteration count: more detail when zoomed in
		maxIter = Math.min(1000, Math.floor(80 + 40 * Math.max(0, Math.log2(1.5 / scale))));

		// Sample smooth iteration count at each CELL CORNER (not cell center).
		// Corner (i, j) in the grid maps to complex (cx + (i - W/2 - 0.5) * dx,
		// cy + (j - H/2 - 0.5) * dy). That way the cell at (x, y) has corners
		// (x, y), (x+1, y), (x, y+1), (x+1, y+1) in the grid, which are its
		// actual visual corners — letting quarter-block chars match the contour.
		const halfW = W / 2;
		const halfH = H / 2;
		const invLog2 = 1 / Math.log(2);
		for (let j = 0; j < cH; j++) {
			const ci = cy + (j - halfH - 0.5) * dyPerRow;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				const cr = cx + (i - halfW - 0.5) * dxPerCol;
				let zr = 0;
				let zi = 0;
				let zr2 = 0;
				let zi2 = 0;
				let it = 0;
				while (it < maxIter && zr2 + zi2 < 256) {
					zi = 2 * zr * zi + ci;
					zr = zr2 - zi2 + cr;
					zr2 = zr * zr;
					zi2 = zi * zi;
					it++;
				}
				if (it >= maxIter) {
					corners[rowOff + i] = -1; // inside
				} else {
					const mag2 = zr2 + zi2;
					const nu = Math.log(Math.log(mag2) * 0.5 * invLog2) * invLog2;
					corners[rowOff + i] = it + 1 - nu;
				}
			}
		}

		// Render via marching-squares over the corner grid. Two layers:
		//   1) inside-set mask → outline of the set, filled-shape chars
		//   2) iso-iteration bands outside the set → nested contour rings
		// Band width grows with zoom so ring count stays readable.
		const band = Math.max(1, Math.round(2 + Math.log2(1.5 / scale) * 0.5));
		const useShape = mode === 'shape' || mode === 'shape-color';
		const useAscii = !useShape && mode !== 'quad';
		const useColor = mode === 'color';
		const useArt = mode === 'art';
		const setChars = useAscii ? ASCII_SET : QUAD_SET;
		const isoChars = useAscii ? ASCII_ISO : QUAD_ISO;

		// Lazy-populate the color palette on first color-mode frame. `c.hsl`
		// returns interned #rrggbb strings so the runtime's palette Map caches
		// them exactly once. 12 hues × 2 (fg/bg) + set colors = 26 palette
		// entries total, well within the bounded-palette budget. The
		// shape-color mode reuses the exact same palette so we don't grow
		// the renderer's color Map unnecessarily.
		if ((useColor || mode === 'shape-color') && bandFg.length === 0) {
			for (let i = 0; i < BAND_COUNT; i++) {
				const h = (i * 360) / BAND_COUNT;
				bandFg.push(c.hsl(h, 0.72, 0.62));
				bandBg.push(c.hsl(h, 0.60, 0.07));
			}
		}

		// ── Shape modes ──────────────────────────────────────────────────
		// Both `shape` and `shape-color` pick each cell's character by
		// SUB-CELL GLYPH MATCHING instead of marching-squares lookup.
		//
		// Algorithm (see also `src/lib/ascii/glyphShape.ts`):
		//
		//   1. Each printable ASCII glyph is rasterized once at startup
		//      into a fixed 8×16 binary sub-cell mask. The rasterization
		//      uses the SAME cell box (advance × line-height) the runtime
		//      writes to the DOM, so the mask captures both the glyph's
		//      ink AND the empty letter-spacing margin around it. That's
		//      what the user means by "account for the spaces in-between
		//      characters" — `(`, for example, has ink centered in the
		//      LEFT 70% of its cell, with the right edge always blank;
		//      `_` has ink along the bottom strip and is empty above.
		//      Matching against the cell-box mask therefore knows where
		//      ink sits inside its cell, not just what its silhouette is.
		//
		//   2. For each fractal cell we build a target mask of the same
		//      shape. We bilinearly interpolate the four corner iteration
		//      values across an 8×16 sub-cell grid and decide "ink/empty"
		//      per sub-cell:
		//        - If any corner is inside the set, ink follows the
		//          interpolated INSIDE flag (so a half-cell silhouette
		//          gets a half-cell mask).
		//        - Otherwise, ink follows whether the interpolated iter
		//          count sits in the MIDDLE HALF of its band period
		//          ((v / band) mod 1 ∈ [0.25, 0.75]). The decision is
		//          made per-sub-cell against a global cycle, NOT against
		//          a per-cell threshold — so both edges of every ring
		//          (inner and outer) pass through partial-ink transition
		//          cells. A per-cell threshold would smooth one edge of
		//          each ring but leave the band-boundary edge as an
		//          abrupt full→empty step, painting the inner ring rim
		//          with a row of dense glyphs (`W`/`#`).
		//
		//   3. The matcher returns the glyph whose binary mask has
		//      minimum Hamming distance from the target.
		//
		// Visual rules baked into the matcher (see glyphShape.matchMask):
		//
		//   A. NOISE-FLOOR TARGET → SPACE. Cells whose target has ≤ 2
		//      sub-cells of ink (out of 128) emit the literal space.
		//      Below that floor a target is almost always interpolation
		//      noise from a corner that's a hair past threshold, not a
		//      real feature.
		//
		//   B. MUST BEAT SPACE. Above the noise floor we still emit
		//      space if the best glyph's SAD ≥ target_ink — i.e. the
		//      glyph contributes more disagreement than it covers. This
		//      is what kills "stray backticks" along curve edges: a tiny
		//      ink sliver in some random corner of the cell would
		//      previously latch onto whichever low-ink glyph happened to
		//      have its ink in that corner (`\``, `'`, `,`, `.`),
		//      reading as scratches floating off to the side of the
		//      actual contour. Now those misaligned matches all fail
		//      the "beat space" guard and emit a clean space instead;
		//      only positional matches (≥50% of the glyph's ink lands
		//      inside the target) survive.
		//
		//   C. TIE-BREAK TOWARD LOWER INK. When two glyphs match the
		//      target equally well, the simpler (less-ink) one wins. This
		//      makes borderline cells default to clean glyphs (`'`, `,`,
		//      `.`) instead of denser ones (`#`, `@`, `M`) that read as
		//      visual noise.
		//
		//   D. FRAMING IS POSITIONAL, NOT NORMALIZED. We do NOT rescale
		//      glyph masks to fill their bounding box — `_` stays as a
		//      bottom-strip mask, `'` stays as a top-right wedge. Position
		//      matters for fractal contours: a horizontal iso-line low in
		//      the cell prefers `_` over `-` because both have horizontal
		//      ink but only `_` matches the BOTTOM region. Similarly an
		//      iso-line high in the cell prefers `\`` or `"` over `_`.
		//
		// Why these rules suit Mandelbrot: bands far outside the set
		// resolve to wide low-ink regions, so rule A keeps them clean;
		// bands close to the set have rich edge structure, so rule D's
		// positional matching makes the rings actually trace their
		// contour through the cell; the cycle-based iso decision (item
		// 2 above) ensures both edges of every ring transition smoothly
		// rather than slamming abruptly into the next band.
		//
		// Debug from devtools (after first shape-mode frame builds atlas):
		//   __glyphShape.dumpFullAtlas()         // every glyph's mask
		//   __glyphShape.probeMatch("##\n  ##")  // top-K matches for a target
		if (useShape) {
			const atlas = getGlyphAtlas();
			if (!atlasLogged) {
				logAtlasSamples();
				atlasLogged = true;
			}
			const wts = getBilinearWeights();
			const target = shapeTarget;
			const colored = mode === 'shape-color';

			for (let y = 0; y < H; y++) {
				const r0 = y * cW;
				const r1 = (y + 1) * cW;
				for (let x = 0; x < W; x++) {
					const tl = corners[r0 + x];
					const tr = corners[r0 + x + 1];
					const bl = corners[r1 + x];
					const br = corners[r1 + x + 1];

					target[0] = 0;
					target[1] = 0;
					target[2] = 0;
					target[3] = 0;

					const insideTL = tl < 0;
					const insideTR = tr < 0;
					const insideBL = bl < 0;
					const insideBR = br < 0;
					const insideMask =
						(insideTL ? 1 : 0) |
						(insideTR ? 2 : 0) |
						(insideBL ? 4 : 0) |
						(insideBR ? 8 : 0);

					if (insideMask === 15) {
						target[0] = 0xffffffff;
						target[1] = 0xffffffff;
						target[2] = 0xffffffff;
						target[3] = 0xffffffff;
					} else if (insideMask !== 0) {
						const a = insideTL ? 1 : 0;
						const b = insideTR ? 1 : 0;
						const cc = insideBL ? 1 : 0;
						const d = insideBR ? 1 : 0;
						for (let i = 0; i < GAREA; i++) {
							const off = i << 2;
							const v =
								a * wts[off] +
								b * wts[off + 1] +
								cc * wts[off + 2] +
								d * wts[off + 3];
							if (v > 0.5) target[i >>> 5] |= 1 << (i & 31);
						}
					} else {
						// Iso-band rings — sub-cell-local "middle of the band
						// cycle" decision. Per sub-cell: ink iff
						//   (v / band) mod 1 ∈ [0.25, 0.75]
						// i.e. the sub-cell sits in the middle half of its
						// band period. This is what fixes the "inner edge of
						// the ring is just Ws" complaint: the previous
						// per-cell threshold was placed at each band's
						// CENTER, which cleanly smooths the OUTER edge of
						// each ring (cells straddling that threshold split
						// into partial-ink masks → varied glyphs) but leaves
						// an abrupt full→empty step at the band BOUNDARY,
						// because the per-cell threshold itself jumps from
						// one band's center to the next there. The cell
						// adjacent to that step always ends up fully inked
						// (matching dense glyphs like `W`/`#`), with no
						// transition cell to bridge it. Driving the decision
						// from the sub-cell's own value — not a per-cell
						// threshold — eliminates the step: BOTH edges of
						// each ring (at v ≈ ¼·band above and below the band
						// peak) now pass through partial-ink cells.
						const invBand = 1 / band;
						for (let i = 0; i < GAREA; i++) {
							const off = i << 2;
							const v =
								tl * wts[off] +
								tr * wts[off + 1] +
								bl * wts[off + 2] +
								br * wts[off + 3];
							const f = v * invBand;
							const fr = f - Math.floor(f);
							if (fr > 0.25 && fr < 0.75) target[i >>> 5] |= 1 << (i & 31);
						}
					}

					const idx = matchMask(target);
					const code = atlas.codes[idx];

					if (colored) {
						let fg: string;
						let bg: string;
						if (insideMask !== 0) {
							fg = SET_FG;
							bg = insideMask === 15 ? SET_BG_CORE : '#000000';
						} else {
							const avg = (tl + tr + bl + br) * 0.25;
							const k = Math.floor(avg / band);
							const bIdx = ((k % BAND_COUNT) + BAND_COUNT) % BAND_COUNT;
							fg = bandFg[bIdx];
							bg = bandBg[bIdx];
						}
						c.set(x, y, String.fromCharCode(code), fg, bg);
					} else {
						// Default fg/bg → keeps the row on the runtime's
						// fast text path even though chars vary per cell.
						c.setI(x, y, code, 0, 1);
					}
				}
			}
		} else {
			for (let y = 0; y < H; y++) {
				const r0 = y * cW;
				const r1 = (y + 1) * cW;
				for (let x = 0; x < W; x++) {
					const tl = corners[r0 + x];
					const tr = corners[r0 + x + 1];
					const bl = corners[r1 + x];
					const br = corners[r1 + x + 1];
	
					// Layer 1: which corners are inside the set
					let m = 0;
					if (tl < 0) m |= 1;
					if (tr < 0) m |= 2;
					if (bl < 0) m |= 4;
					if (br < 0) m |= 8;
	
					if (m !== 0) {
						if (useColor) {
							// Fully-interior cells get a dim warm backing; boundary
							// cells sit on black so the silhouette's edge pops.
							const bg = m === 15 ? SET_BG_CORE : '#000000';
							c.set(x, y, setChars[m], SET_FG, bg);
						} else if (useArt) {
							if (m === 15) {
								// Set interior — solid black silhouette, the same
								// way classic mandelbrot posters render it.
								c.set(x, y, ' ', ANSI_BLACK, ANSI_BLACK);
							} else {
								// Boundary cell — inherit the approaching ring's
								// color from whichever corner just barely escaped,
								// so the set rim lights up with the adjacent band.
								let oi: number;
								if (tl >= 0) oi = tl;
								else if (tr >= 0) oi = tr;
								else if (bl >= 0) oi = bl;
								else oi = br;
								const pos = oi / band;
								const lo = ((Math.floor(pos) % ART_LEN) + ART_LEN) % ART_LEN;
								const frac = pos - Math.floor(pos);
								const hi = (lo + 1) % ART_LEN;
								const bt = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
								const idx = bt < frac ? hi : lo;
								c.set(x, y, setChars[m], ART_FG[idx], ART_BG[idx]);
							}
						} else {
							c.set(x, y, setChars[m]);
						}
						continue;
					}
	
					// Layer 2: iso-contour rings. Threshold halfway between integer
					// bands near the average; corners above/below split the cell
					// into a marching-squares case.
					const avg = (tl + tr + bl + br) * 0.25;
					const bandIdx = Math.floor(avg / band);
					const thr = bandIdx * band + band * 0.5;
					let cm = 0;
					if (tl > thr) cm |= 1;
					if (tr > thr) cm |= 2;
					if (bl > thr) cm |= 4;
					if (br > thr) cm |= 8;
					if (useColor) {
						const idx = ((bandIdx % BAND_COUNT) + BAND_COUNT) % BAND_COUNT;
						c.set(x, y, isoChars[cm], bandFg[idx], bandBg[idx]);
					} else if (useArt) {
						// Iteration band → gradient index. pos is the fractional
						// band position; floor gives the stripe color, Bayer dither
						// against `frac` paints a cross-hatched transition to the
						// next stripe at the boundary. One full cycle of the
						// 12-stop ANSI palette spans 12 bands, so ring count
						// scales naturally with zoom (same `band` tuning used for
						// the contour threshold earlier).
						const pos = avg / band;
						const lo = ((Math.floor(pos) % ART_LEN) + ART_LEN) % ART_LEN;
						const frac = pos - Math.floor(pos);
						const hi = (lo + 1) % ART_LEN;
						const bt = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
						const idx = bt < frac ? hi : lo;
						c.set(x, y, isoChars[cm], ART_FG[idx], ART_BG[idx]);
					} else {
						c.set(x, y, isoChars[cm]);
					}
				}
			}
		}

		// Crosshair at center
		const ccx = Math.floor(W / 2);
		const ccy = Math.floor(H / 2);
		c.set(ccx, ccy, '+');

		if (W >= 60 && H >= 12) {
			const hud1 = `center: ${cx.toFixed(10)}  ${cy >= 0 ? '+' : ''}${cy.toFixed(10)}i`;
			const hud2 = `zoom: ${(1.5 / scale).toExponential(2)}  iter: ${maxIter}  mode: ${mode}  fps: ${Math.round(c.fps)}`;
			c.text(1, 1, hud1);
			c.text(1, 2, hud2);
		}
	}
</script>

<AsciiCanvas effect={draw} selectable={false} />
