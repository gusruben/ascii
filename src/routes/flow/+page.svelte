<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Streamline typography. ψ(x, y, t) is a curl-noise streamfunction — three
	// drifting sines whose level sets ARE the streamlines (since v = ∇ψ × ẑ,
	// flow runs parallel to contours of ψ). Per cell we sample ψ at the 4
	// corners, run marching squares against the nearest stripe threshold, and
	// emit the ASCII char whose ink falls in the same quadrants as the
	// above-threshold corners — so the character literally traces the local
	// streamline through that cell.
	//
	// The mouse adds a Gaussian-windowed contribution to ψ. The curl of a
	// Gaussian is a tangential ring-shaped flow with no singularity at the
	// center, so streamlines spiral smoothly around the cursor instead of
	// blowing up.
	//
	// Marching-squares mask: bit1=TL, 2=TR, 4=BL, 8=BR (corners above thr).
	// Each char's ink falls in the same quadrants as its above-threshold
	// corners — same approach as the mandelbrot ASCII_ISO lookup, retuned
	// here for fluid streamlines:
	//   0  none      ' '   no contour
	//   1  TL        '`'   top-left wedge
	//   2  TR        "'"   top-right wedge
	//   3  top       '"'   horizontal stripe at top
	//   4  BL        ','   bottom-left wedge
	//   5  left      '('   curve hugging left edge
	//   6  TR+BL     '/'   anti-diagonal
	//   7  not BR    'F'   top + left stem, cuts off BR
	//   8  BR        '.'   bottom-right wedge
	//   9  TL+BR     '\'   main diagonal
	//  10  right     ')'   curve hugging right edge
	//  11  not BL    '?'   top curl + right stem + bottom dot
	//  12  bottom    '_'   horizontal stripe at bottom
	//  13  not TR    'L'   left + bottom, cuts off TR
	//  14  not TL    'J'   right + bottom curl, cuts off TL
	//  15  all       ' '   fully inside band, no contour
	const ISO_CODES = new Uint16Array([
		32, 96, 39, 34, 44, 40, 47, 70, 46, 92, 41, 63, 95, 76, 74, 32
	]);

	function psiBase(x: number, y: number, t: number): number {
		return (
			Math.sin(x * 0.13 + t * 0.45) * Math.cos(y * 0.18 - t * 0.3) +
			Math.sin((x + y * 0.7) * 0.09 + t * 0.62) * 0.85 +
			Math.cos((x * 0.6 - y) * 0.11 - t * 0.4) * 0.65
		);
	}

	// Adds a localized "vortex" to ψ. Bumping ψ by a Gaussian rather than a
	// pole keeps the velocity finite at the cursor — pole-based vortices
	// produce infinite tangential speed at the center and a ring of dense
	// noise around it.
	function mouseContrib(dx: number, dy: number): number {
		const r2 = dx * dx + dy * dy;
		if (r2 > 900) return 0;
		return 6 * Math.exp(-r2 / 200);
	}

	let corners = new Float32Array(0);
	let cornerW = 0;
	let cornerH = 0;
	let frames = 0;
	let mouseSeen = false;

	function effect(c: AsciiApi) {
		const W = c.cols;
		const H = c.rows;
		const aspect = c.cellAspect;
		const cW = W + 1;
		const cH = H + 1;
		if (cW !== cornerW || cH !== cornerH) {
			cornerW = cW;
			cornerH = cH;
			corners = new Float32Array(cW * cH);
		}

		const t = c.elapsed;

		// Self-demo cursor: orbit a virtual mouse around the canvas until the
		// real cursor first moves. Same pattern the fire demo uses so the
		// effect runs visibly inside the index-page iframe.
		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;
		let mx: number;
		let myV: number;
		if (mouseSeen) {
			mx = c.mouse.fx;
			myV = c.mouse.fy * aspect;
		} else {
			const z = frames / 60;
			mx = W / 2 + Math.sin(z) * W * 0.3;
			myV = (H / 2 + Math.cos(z * 1.3) * H * 0.3) * aspect;
		}

		// Sample ψ at every corner. Visual y = corner_j * aspect so the field
		// is isotropic — circular vortices stay round instead of vertically
		// squashed by the ~2:1 cell aspect.
		for (let j = 0; j < cH; j++) {
			const yy = j * aspect;
			const rowOff = j * cW;
			for (let i = 0; i < cW; i++) {
				corners[rowOff + i] = psiBase(i, yy, t) + mouseContrib(i - mx, yy - myV);
			}
		}

		// Stripe spacing. Smaller = more visible streamlines per unit area.
		// ψ ranges roughly ±2.5, so STRIPE = 0.55 gives ~9 stripe bands across
		// the field plus extra rings around the mouse vortex.
		const STRIPE = 0.55;
		const invStripe = 1 / STRIPE;

		for (let y = 0; y < H; y++) {
			const r0 = y * cW;
			const r1 = (y + 1) * cW;
			for (let x = 0; x < W; x++) {
				const tl = corners[r0 + x];
				const tr = corners[r0 + x + 1];
				const bl = corners[r1 + x];
				const br = corners[r1 + x + 1];

				// Single-threshold marching squares: pick the threshold for the
				// band that contains the cell's average ψ. The contour for that
				// band is the streamline running through this cell.
				const avg = (tl + tr + bl + br) * 0.25;
				const k = Math.floor(avg * invStripe);
				const thr = (k + 0.5) * STRIPE;

				let m = 0;
				if (tl > thr) m |= 1;
				if (tr > thr) m |= 2;
				if (bl > thr) m |= 4;
				if (br > thr) m |= 8;

				// Default fg/bg keeps the row on the runtime's text fast path
				// even though chars vary per cell — no per-cell color cost.
				c.setI(x, y, ISO_CODES[m], 0, 1);
			}
		}

		frames++;
		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
