<script lang="ts">
	// A ball that lives in the world frame: drag or resize the window and it
	// lags behind, then springs back to the canvas center. Window motion on
	// the physical screen is converted to cell units and injected as an
	// inertial offset on the ball's position + velocity.
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	let bx = 0; // ball position in cell units (visual y, i.e. y_cell * aspect)
	let by = 0;
	let vx = 0;
	let vy = 0;
	let initialized = false;

	let prevSX = 0;
	let prevSY = 0;
	let winInit = false;

	let prevMX = 0;
	let prevMY = 0;
	let mouseInit = false;

	const K = 9; // spring stiffness toward center
	const D = 2.6; // damping
	// How much of the window's motion the ball tracks immediately in world
	// space. 1.0 = fully world-fixed (old behavior, snaps on fast moves).
	// Lower = ball "sticks" to the window a bit, so fast whips don't fully
	// displace it on the first frame.
	const WORLD_LOCK = 0.82;
	// Extra velocity inherited from window motion, for coast after release.
	const MOVE_GAIN = 0.05;

	function effect(c: AsciiApi) {
		const aspect = c.cellAspect;
		const cx = c.cols / 2;
		const cy = (c.rows * aspect) / 2;

		if (!initialized) {
			bx = cx;
			by = cy;
			initialized = true;
		}

		const dt = Math.min(c.dt || 1 / 60, 1 / 30);
		const invDt = dt > 0 ? 1 / dt : 0;

		// --- window motion → inertial offset on the ball ---
		if (!winInit) {
			prevSX = window.screenX;
			prevSY = window.screenY;
			winInit = true;
		}
		const sx = window.screenX;
		const sy = window.screenY;
		let dsx = sx - prevSX;
		let dsy = sy - prevSY;
		prevSX = sx;
		prevSY = sy;
		// RAF often pauses while the window is being dragged, so the first
		// frame after release sees one big accumulated delta with an equally
		// inflated invDt. Skip the injection on those resume frames — otherwise
		// a normal drag launches the ball across the screen.
		const paused = (c.dt || 0) > 1 / 20;
		if (paused || Math.abs(dsx) > 800 || Math.abs(dsy) > 800) {
			dsx = 0;
			dsy = 0;
		}
		const pxPerCellX = Math.max(1, window.innerWidth / c.cols);
		const pxPerCellY = Math.max(1, window.innerHeight / c.rows);
		const dsxSim = dsx / pxPerCellX;
		const dsySim = (dsy / pxPerCellY) * aspect;

		// Window moves right on screen → ball appears to move left in canvas
		// coords. Most of the motion is applied as an instant offset so fast
		// drags feel responsive (not "ball accelerating from rest"), but a
		// fraction is held back as a velocity kick so the ball coasts briefly
		// after release — that gives the slight drag/heaviness feel.
		bx -= dsxSim * WORLD_LOCK;
		by -= dsySim * WORLD_LOCK;
		vx -= dsxSim * invDt * MOVE_GAIN;
		vy -= dsySim * invDt * MOVE_GAIN;

		// --- mouse push: a fast-moving cursor drags the orb along with it ---
		if (c.mouse.x >= 0 && c.mouse.y >= 0) {
			const mx = c.mouse.fx;
			const my = c.mouse.fy * aspect;
			if (!mouseInit) {
				prevMX = mx;
				prevMY = my;
				mouseInit = true;
			}
			// mouse velocity in the ball's visual-cell space
			const mvx = (mx - prevMX) * invDt;
			const mvy = (my - prevMY) * invDt;
			prevMX = mx;
			prevMY = my;

			const pdx = bx - mx;
			const pdy = by - my;
			const pdist = Math.hypot(pdx, pdy);
			const PUSH_R = 12; // cells (visual units)
			const PUSH_GAIN = 0.35; // fraction of mouse velocity transferred
			if (pdist < PUSH_R) {
				const falloff = 1 - pdist / PUSH_R;
				// only push when the mouse is moving *toward* the orb
				const approach = -(mvx * (pdx / (pdist || 1)) + mvy * (pdy / (pdist || 1)));
				if (approach > 0) {
					const g = PUSH_GAIN * falloff * falloff;
					vx += mvx * g;
					vy += mvy * g;
				}
			}
		} else {
			mouseInit = false;
		}

		// --- spring toward center ---
		const ax = -K * (bx - cx) - D * vx;
		const ay = -K * (by - cy) - D * vy;
		vx += ax * dt;
		vy += ay * dt;
		bx += vx * dt;
		by += vy * dt;

		// --- draw ---
		c.fill(' ', '#9ab', '#020814');

		// dark blue marker at the true canvas center — drawn before the glow,
		// and the glow only touches cells within its radius, so the dot peeks
		// through whenever the ball isn't on top of it.
		c.set(Math.floor(cx), Math.floor(cy / aspect), '•', '#1a3a7a', '#020814');

		// Lit sphere: outer falloff glow (single tone) plus a shaded core
		// using three tones driven by a Lambert term against a fixed light.
		const R = 6.5;
		const Rcore = 3.2;
		const R2 = R * R;
		const Rcore2 = Rcore * Rcore;
		const RAMP = ' .`:;+*oxO%#@';
		const rampMax = RAMP.length - 1;

		// light direction (up and slightly left); normalized
		const lxRaw = -0.55;
		const lyRaw = -0.75;
		const lLen = Math.hypot(lxRaw, lyRaw);
		const lx = lxRaw / lLen;
		const ly = lyRaw / lLen;

		const COL_HI = '#eaf6ff';
		const COL_MID = '#6cd6ff';
		const COL_LO = '#4b8fc2';
		const COL_GLOW = '#24507a';
		const BG = '#020814';

		const xMin = Math.max(0, Math.floor(bx - R));
		const xMax = Math.min(c.cols - 1, Math.ceil(bx + R));
		const yMin = Math.max(0, Math.floor((by - R) / aspect));
		const yMax = Math.min(c.rows - 1, Math.ceil((by + R) / aspect));
		for (let y = yMin; y <= yMax; y++) {
			for (let x = xMin; x <= xMax; x++) {
				const dx = x - bx;
				const dy = y * aspect - by;
				const r2 = dx * dx + dy * dy;
				if (r2 >= R2) continue;

				if (r2 <= Rcore2) {
					// shaded body: fake 3D normal from in-disk offset
					const nx = dx / Rcore;
					const ny = dy / Rcore;
					const zz = Math.max(0, 1 - nx * nx - ny * ny);
					const nz = Math.sqrt(zz);
					// light from above; add a bit of ambient via nz weight
					let lit = nx * lx + ny * ly + nz * 0.45 + 0.15;
					if (lit < 0) lit = 0;
					else if (lit > 1) lit = 1;

					let ch: string;
					let fg: string;
					if (lit > 0.72) {
						fg = COL_HI;
						ch = '@';
					} else if (lit > 0.38) {
						fg = COL_MID;
						ch = '%';
					} else {
						fg = COL_LO;
						ch = 'o';
					}
					c.set(x, y, ch, fg, BG);
				} else {
					// outer falloff, single tone so these rows can stay uniform
					const t = 1 - (Math.sqrt(r2) - Rcore) / (R - Rcore);
					const idx = Math.min(rampMax, Math.max(0, Math.floor(t * (rampMax + 1))));
					if (idx === 0) continue;
					c.set(x, y, RAMP[idx], COL_GLOW, BG);
				}
			}
		}

		// specular highlight — one bright cell offset toward the light
		const hx = Math.round(bx + lx * Rcore * 0.55);
		const hy = Math.round((by + ly * Rcore * 0.55) / aspect);
		if (hx >= 0 && hx < c.cols && hy >= 0 && hy < c.rows) {
			c.set(hx, hy, '#', '#ffffff', BG);
		}

		c.text(0, 0, Math.round(c.fps) + ' FPS', '#9ab', '#020814');
		c.text(
			0,
			1,
			`screen ${sx},${sy}  Δ ${dsx.toFixed(0)},${dsy.toFixed(0)}`,
			'#9ab',
			'#020814'
		);
	}
</script>

<AsciiCanvas {effect} />
