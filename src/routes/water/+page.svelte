<script lang="ts">
	// Position-Based Fluid following Matthias Müller's "Ten Minute Physics".
	// Particles are stored as parallel Float32Arrays (struct-of-arrays) so
	// the solver/viscosity/splat inner loops run over typed arrays instead
	// of chasing object pointers — measurably tighter in V8.
	// y is stored in visual units (y_cell * cellAspect) so distances are isotropic.
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { onMount } from 'svelte';

	const RAMP = ' .`:;+*oxO%#@';
	const D0 = 1.3; // target minimum inter-particle separation (visual units)
	const H_VIS = 1.7; // viscosity/density-splat radius
	// Mobile perf envelope is ~2-3× lower than desktop; halve particles + substeps.
	const IS_MOBILE =
		typeof window !== 'undefined' &&
		('ontouchstart' in window || (navigator as any).maxTouchPoints > 0);
	const SUBSTEPS = IS_MOBILE ? 2 : 3;
	const ITER_PER_STEP = 3;
	const VISC = 0.22; // XSPH blend factor
	const GRAV = 140; // visual units / s²
	const DAMP = 0.999; // per-substep velocity damping
	// Restitution for constraint-induced velocity only (0 = absorbed, 1 = elastic).
	// Damping only this component removes the surface "jumping" without damping
	// free-fall.
	const CORR_REST = 0.25;
	const MOUSE_R = 8;
	const MOUSE_REPEL = 900;
	const MOUSE_DRAG = 12;
	const CAP = 2000; // hard particle cap — desktop ceiling
	const MAX_N = IS_MOBILE ? 900 : 1800;

	// --- device tilt → gravity vector ---
	// beta: front-back tilt (−180..180), gamma: left-right (−90..90).
	// We turn tilt into a unit direction, then scale by GRAV in the integrator.
	let gDirX = 0;
	let gDirY = 1;
	let orientationReady = false;
	let needsPermission = $state(false);
	let permissionError = $state('');

	function handleOrientation(e: DeviceOrientationEvent) {
		const beta = e.beta ?? 0;
		const gamma = e.gamma ?? 0;
		// Map tilt to a gravity direction. At rest face-up beta≈0, gamma≈0 → straight down.
		// When tilted, sin of each angle gives the horizontal/vertical component.
		const br = (beta * Math.PI) / 180;
		const gr = (gamma * Math.PI) / 180;
		// x component from gamma (side tilt), y component from beta (forward tilt)
		// In portrait: tilting right (gamma > 0) should push water right → +x.
		// Tilting phone toward you (beta < 0) should reduce downward pull / push up.
		let dx = Math.sin(gr);
		let dy = Math.sin(br);
		// If phone is face-up flat (beta ~ 0), we still want "down" in screen = +y.
		// Use cos of combined tilt as the "into screen" component and project onto y.
		// Simpler: if both tilts tiny, fall back to (0, 1).
		const mag = Math.sqrt(dx * dx + dy * dy);
		if (mag < 0.02) {
			dx = 0;
			dy = 1;
		} else {
			// Normalize so gravity magnitude stays constant regardless of tilt amount.
			// Cap tilt contribution at 1 (90° tilt = full lateral gravity).
			const m = Math.min(1, mag);
			dx = (dx / mag) * m;
			dy = (dy / mag) * m;
			// Add the remaining "down" component from being mostly flat.
			const rest = Math.sqrt(Math.max(0, 1 - m * m));
			dy += rest;
			const n = Math.sqrt(dx * dx + dy * dy) || 1;
			dx /= n;
			dy /= n;
		}
		gDirX = dx;
		gDirY = dy;
		orientationReady = true;
	}

	async function requestMotionPermission() {
		const AnyDOE = (window as any).DeviceOrientationEvent;
		try {
			if (AnyDOE && typeof AnyDOE.requestPermission === 'function') {
				const res = await AnyDOE.requestPermission();
				if (res !== 'granted') {
					permissionError = 'Motion permission denied';
					return;
				}
			}
			window.addEventListener('deviceorientation', handleOrientation, true);
			needsPermission = false;
		} catch (err) {
			permissionError = String(err);
		}
	}

	// Forward touches as mousemove events on the <pre> so the runtime's
	// existing c.mouse tracking picks them up. Also track "is touching"
	// so we can move the finger offscreen between touches instead of
	// leaving a ghost repel point where the last touch ended.
	let touching = $state(false);

	function forwardTouch(e: TouchEvent) {
		const t = e.touches[0] ?? e.changedTouches[0];
		if (!t) return;
		const pre = document.querySelector('pre');
		if (!pre) return;
		pre.dispatchEvent(
			new MouseEvent('mousemove', {
				clientX: t.clientX,
				clientY: t.clientY,
				bubbles: true
			})
		);
	}

	function onTouchStart(e: TouchEvent) {
		touching = true;
		forwardTouch(e);
		e.preventDefault();
	}
	function onTouchMove(e: TouchEvent) {
		forwardTouch(e);
		e.preventDefault();
	}
	function onTouchEnd(e: TouchEvent) {
		touching = false;
		// Park the "mouse" far offscreen so the repel zone is inactive until next touch.
		const pre = document.querySelector('pre');
		if (pre) {
			pre.dispatchEvent(new MouseEvent('mousemove', { clientX: -10000, clientY: -10000, bubbles: true }));
		}
		e.preventDefault();
	}

	onMount(() => {
		const AnyDOE = (window as any).DeviceOrientationEvent;
		if (AnyDOE && typeof AnyDOE.requestPermission === 'function') {
			needsPermission = true;
		} else if (AnyDOE) {
			window.addEventListener('deviceorientation', handleOrientation, true);
		}
		window.addEventListener('touchstart', onTouchStart, { passive: false });
		window.addEventListener('touchmove', onTouchMove, { passive: false });
		window.addEventListener('touchend', onTouchEnd, { passive: false });
		window.addEventListener('touchcancel', onTouchEnd, { passive: false });
		return () => {
			window.removeEventListener('deviceorientation', handleOrientation, true);
			window.removeEventListener('touchstart', onTouchStart);
			window.removeEventListener('touchmove', onTouchMove);
			window.removeEventListener('touchend', onTouchEnd);
			window.removeEventListener('touchcancel', onTouchEnd);
		};
	});

	// Parallel arrays — px[i]/py[i] is particle i's position, etc.
	const px = new Float32Array(CAP);
	const py = new Float32Array(CAP);
	const vx = new Float32Array(CAP);
	const vy = new Float32Array(CAP);
	const ox = new Float32Array(CAP); // start-of-substep position
	const oy = new Float32Array(CAP);
	const ivx = new Float32Array(CAP); // "intended" velocity post-gravity, pre-constraint
	const ivy = new Float32Array(CAP);
	// Frame-to-frame previous position (for wake deposits). Separate from ox/oy
	// which are per-substep scratch space for the constraint solver.
	const prevPx = new Float32Array(CAP);
	const prevPy = new Float32Array(CAP);
	let prevPosReady = false;
	let n = 0;

	let gridHead = new Int32Array(0);
	const gridNext = new Int32Array(CAP);
	let gridCols = 0;
	let gridRows = 0;
	const CELL = D0;

	let density = new Float32Array(0);
	let prevDensity = new Float32Array(0);
	// Per-cell average velocity (for flow-aligned glyphs). Summed during splat,
	// then divided by cellCount to get the dominant flow direction per cell.
	let cellVX = new Float32Array(0);
	let cellVY = new Float32Array(0);
	let cellCount = new Uint16Array(0);
	// Temporally-smoothed unit direction per cell. Without this, cells whose
	// avg velocity hovers near a bucket boundary flip glyphs every frame and
	// the body looks flickery.
	let smoothDirX = new Float32Array(0);
	let smoothDirY = new Float32Array(0);

	let prevCols = 0;
	let prevRows = 0;
	let prevAspect = 0;
	let ready = false;

	// Desktop-only: window-drag inertia kick
	let prevSX = 0;
	let prevSY = 0;
	let winInit = false;

	function initSim(cols: number, rows: number, aspect: number) {
		const Hh = rows * aspect;
		const spacing = D0 * 1.05;
		const rowStride = spacing * 0.9;
		const yTop = Hh * 0.35;
		const yBot = Hh - 0.8;
		const xL = 1.0;
		const xR = cols - 1.0;
		let idx = 0;
		let row = 0;
		outer: for (let y = yBot; y > yTop; y -= rowStride, row++) {
			const off = row % 2 ? spacing * 0.5 : 0;
			for (let x = xL + off; x < xR; x += spacing) {
				if (idx >= MAX_N) break outer;
				px[idx] = x + (Math.random() - 0.5) * 0.05;
				py[idx] = y + (Math.random() - 0.5) * 0.05;
				vx[idx] = 0;
				vy[idx] = 0;
				ox[idx] = 0;
				oy[idx] = 0;
				ivx[idx] = 0;
				ivy[idx] = 0;
				idx++;
			}
		}
		n = idx;

		gridCols = Math.ceil(cols / CELL) + 2;
		gridRows = Math.ceil(Hh / CELL) + 2;
		gridHead = new Int32Array(gridCols * gridRows);
		density = new Float32Array(cols * rows);
		prevDensity = new Float32Array(cols * rows);
		cellVX = new Float32Array(cols * rows);
		cellVY = new Float32Array(cols * rows);
		cellCount = new Uint16Array(cols * rows);
		smoothDirX = new Float32Array(cols * rows);
		smoothDirY = new Float32Array(cols * rows);
	}

	function resizeSim(cols: number, rows: number, aspect: number) {
		const Hh = rows * aspect;
		// rescale y if aspect changed (rare). Stored y = y_cell * aspect.
		if (prevAspect > 0 && prevAspect !== aspect) {
			const ratio = aspect / prevAspect;
			for (let i = 0; i < n; i++) {
				py[i] *= ratio;
				oy[i] *= ratio;
				vy[i] *= ratio;
				ivy[i] *= ratio;
			}
		}

		// push out-of-bounds particles inward with a kick proportional to overshoot
		const xMin = 0.3;
		const xMax = cols - 0.3;
		const yMin = 0.3;
		const yMax = Hh - 0.3;
		const KICK = 30;
		for (let i = 0; i < n; i++) {
			if (px[i] > xMax) {
				const over = px[i] - xMax;
				px[i] = xMax;
				vx[i] -= over * KICK;
			} else if (px[i] < xMin) {
				const over = xMin - px[i];
				px[i] = xMin;
				vx[i] += over * KICK;
			}
			if (py[i] > yMax) {
				const over = py[i] - yMax;
				py[i] = yMax;
				vy[i] -= over * KICK;
			} else if (py[i] < yMin) {
				py[i] = yMin;
			}
		}

		gridCols = Math.ceil(cols / CELL) + 2;
		gridRows = Math.ceil(Hh / CELL) + 2;
		gridHead = new Int32Array(gridCols * gridRows);
		density = new Float32Array(cols * rows);
		prevDensity = new Float32Array(cols * rows);
		cellVX = new Float32Array(cols * rows);
		cellVY = new Float32Array(cols * rows);
		cellCount = new Uint16Array(cols * rows);
		smoothDirX = new Float32Array(cols * rows);
		smoothDirY = new Float32Array(cols * rows);
		prevPosReady = false;
	}

	function rebuildGrid() {
		gridHead.fill(-1);
		const invCell = 1 / CELL;
		const maxGx = gridCols - 3;
		const maxGy = gridRows - 3;
		for (let i = 0; i < n; i++) {
			let gx = (px[i] * invCell) | 0;
			let gy = (py[i] * invCell) | 0;
			if (gx < 0) gx = 0;
			else if (gx > maxGx) gx = maxGx;
			if (gy < 0) gy = 0;
			else if (gy > maxGy) gy = maxGy;
			gx += 1;
			gy += 1;
			const gi = gy * gridCols + gx;
			gridNext[i] = gridHead[gi];
			gridHead[gi] = i;
		}
	}

	function effect(c: AsciiApi) {
		const aspect = c.cellAspect;
		if (!ready) {
			initSim(c.cols, c.rows, aspect);
			ready = true;
		} else if (c.cols !== prevCols || c.rows !== prevRows || aspect !== prevAspect) {
			resizeSim(c.cols, c.rows, aspect);
		}
		prevCols = c.cols;
		prevRows = c.rows;
		prevAspect = aspect;

		const W = c.cols;
		const Hh = c.rows * aspect;
		const dt = Math.min(c.dt || 1 / 60, 1 / 30);
		const invDt = dt > 0 ? 1 / dt : 0;

		// --- window motion → velocity kick (desktop only; mobile window doesn't move) ---
		if (!IS_MOBILE) {
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
			// rAF typically pauses during a window drag and fires once at release
			// with one huge accumulated delta plus a maxed-out invDt. That
			// multiplies into a velocity kick that pins all the water to one wall.
			// Drop the injection on those resume frames.
			const paused = (c.dt || 0) > 1 / 20;
			if (paused || Math.abs(dsx) > 200 || Math.abs(dsy) > 200) {
				dsx = 0;
				dsy = 0;
			}
			const pxPerCellX = Math.max(1, window.innerWidth / c.cols);
			const pxPerCellY = Math.max(1, window.innerHeight / c.rows);
			const GAIN = 0.07;
			const dsxSim = (dsx / pxPerCellX) * invDt * GAIN;
			const dsySim = (dsy / pxPerCellY) * aspect * invDt * GAIN;
			for (let i = 0; i < n; i++) {
				vx[i] -= dsxSim;
				vy[i] -= dsySim;
			}
		}

		// --- mouse interaction: radial repel + velocity drag ---
		const mx = c.mouse.x + 0.5;
		const myVis = (c.mouse.y + 0.5) * aspect;
		const mInside = c.mouse.x >= 0 && c.mouse.x < W && c.mouse.y >= 0 && c.mouse.y < c.rows;
		let mvx = (c.mouse.x - c.mouse.px) * invDt;
		let mvyVis = (c.mouse.y - c.mouse.py) * aspect * invDt;
		if (mvx > 400) mvx = 400;
		else if (mvx < -400) mvx = -400;
		if (mvyVis > 400) mvyVis = 400;
		else if (mvyVis < -400) mvyVis = -400;

		if (mInside) {
			const R2 = MOUSE_R * MOUSE_R;
			const repelDt = MOUSE_REPEL * dt;
			const dragDt = MOUSE_DRAG * dt;
			const invMR = 1 / MOUSE_R;
			for (let i = 0; i < n; i++) {
				const dx = px[i] - mx;
				const dy = py[i] - myVis;
				const r2 = dx * dx + dy * dy;
				if (r2 < R2) {
					const r = Math.sqrt(r2) + 1e-4;
					const w = 1 - r * invMR;
					const fScale = (repelDt * w) / r;
					vx[i] += dx * fScale;
					vy[i] += dy * fScale;
					const dScale = w * dragDt;
					vx[i] += (mvx - vx[i]) * dScale;
					vy[i] += (mvyVis - vy[i]) * dScale;
				}
			}
		}

		// --- XPBD-style substeps ---
		const sdt = dt / SUBSTEPS;
		const invSdt = 1 / sdt;
		const D0_2 = D0 * D0;
		const xMin = 0.3;
		const xMax = W - 0.3;
		const yMin = 0.3;
		const yMax = Hh - 0.3;
		const gSdtX = GRAV * gDirX * sdt;
		const gSdtY = GRAV * gDirY * sdt;
		const invCell = 1 / CELL;

		for (let step = 0; step < SUBSTEPS; step++) {
			// integrate (predict), save intended velocity pre-constraint
			for (let i = 0; i < n; i++) {
				const nvx = (vx[i] + gSdtX) * DAMP;
				const nvy = (vy[i] + gSdtY) * DAMP;
				vx[i] = nvx;
				vy[i] = nvy;
				ivx[i] = nvx;
				ivy[i] = nvy;
				ox[i] = px[i];
				oy[i] = py[i];
				px[i] += nvx * sdt;
				py[i] += nvy * sdt;
			}

			// Gauss-Seidel with alternating direction. Visit each pair once per
			// iter via (j>i forward / j<i backward) — same result as j!==i but
			// half the pair ops, since the "redundant" visit from the other side
			// is a no-op once the pair is satisfied.
			for (let iter = 0; iter < ITER_PER_STEP; iter++) {
				rebuildGrid();
				const forward = (iter & 1) === 0;
				const iStart = forward ? 0 : n - 1;
				const iEnd = forward ? n : -1;
				const iStep = forward ? 1 : -1;
				for (let i = iStart; i !== iEnd; i += iStep) {
					const gx = ((px[i] * invCell) | 0) + 1;
					const gy = ((py[i] * invCell) | 0) + 1;
					for (let oyG = -1; oyG <= 1; oyG++) {
						const gyy = gy + oyG;
						if (gyy < 0 || gyy >= gridRows) continue;
						const rowBase = gyy * gridCols;
						for (let oxG = -1; oxG <= 1; oxG++) {
							const gxx = gx + oxG;
							if (gxx < 0 || gxx >= gridCols) continue;
							let j = gridHead[rowBase + gxx];
							while (j !== -1) {
								// (j-i)*iStep>0 picks exactly one side: j>i in forward sweeps,
								// j<i in backward. Also excludes j===i (diff=0 => not >0).
								if ((j - i) * iStep > 0) {
									const dx = px[j] - px[i];
									const dy = py[j] - py[i];
									const r2 = dx * dx + dy * dy;
									if (r2 < D0_2 && r2 > 1e-8) {
										const r = Math.sqrt(r2);
										// factor = err/r; dx*factor is cheaper than (dx/r)*err
										const factor = ((D0 - r) * 0.5) / r;
										const exN = dx * factor;
										const eyN = dy * factor;
										px[i] -= exN;
										py[i] -= eyN;
										px[j] += exN;
										py[j] += eyN;
									} else if (r2 < 1e-8) {
										px[i] -= D0 * 0.25;
										px[j] += D0 * 0.25;
									}
								}
								j = gridNext[j];
							}
						}
					}

					// wall projection
					if (px[i] < xMin) px[i] = xMin;
					else if (px[i] > xMax) px[i] = xMax;
					if (py[i] < yMin) py[i] = yMin;
					else if (py[i] > yMax) py[i] = yMax;
				}
			}

			// recover velocity, damping only the constraint-correction component
			for (let i = 0; i < n; i++) {
				const vxTotal = (px[i] - ox[i]) * invSdt;
				const vyTotal = (py[i] - oy[i]) * invSdt;
				const corrX = vxTotal - ivx[i];
				const corrY = vyTotal - ivy[i];
				let nvx = ivx[i] + corrX * CORR_REST;
				let nvy = ivy[i] + corrY * CORR_REST;

				// wall friction: zero normal component if parked on a wall
				if (px[i] <= xMin + 1e-4 && nvx < 0) nvx = 0;
				else if (px[i] >= xMax - 1e-4 && nvx > 0) nvx = 0;
				if (py[i] <= yMin + 1e-4 && nvy < 0) nvy = 0;
				else if (py[i] >= yMax - 1e-4 && nvy > 0) nvy = 0;

				if (nvx > 200) nvx = 200;
				else if (nvx < -200) nvx = -200;
				if (nvy > 200) nvy = 200;
				else if (nvy < -200) nvy = -200;
				vx[i] = nvx;
				vy[i] = nvy;
			}
		}

		// --- XSPH viscosity: one pass/frame, symmetric pair updates (j>i) ---
		rebuildGrid();
		const HVIS_2 = H_VIS * H_VIS;
		const invHVis = 1 / H_VIS;
		for (let i = 0; i < n; i++) {
			const pxi = px[i];
			const pyi = py[i];
			const gx = ((pxi * invCell) | 0) + 1;
			const gy = ((pyi * invCell) | 0) + 1;
			for (let oyG = -1; oyG <= 1; oyG++) {
				const gyy = gy + oyG;
				if (gyy < 0 || gyy >= gridRows) continue;
				const rowBase = gyy * gridCols;
				for (let oxG = -1; oxG <= 1; oxG++) {
					const gxx = gx + oxG;
					if (gxx < 0 || gxx >= gridCols) continue;
					let j = gridHead[rowBase + gxx];
					while (j !== -1) {
						if (j > i) {
							const dx = px[j] - pxi;
							const dy = py[j] - pyi;
							const r2 = dx * dx + dy * dy;
							if (r2 < HVIS_2) {
								const w = 1 - Math.sqrt(r2) * invHVis;
								const c2 = VISC * w;
								const dvx = (vx[j] - vx[i]) * c2;
								const dvy = (vy[j] - vy[i]) * c2;
								vx[i] += dvx;
								vy[i] += dvy;
								vx[j] -= dvx;
								vy[j] -= dvy;
							}
						}
						j = gridNext[j];
					}
				}
			}
		}

		// --- density + velocity splat (for flow glyphs) ---
		density.fill(0);
		cellVX.fill(0);
		cellVY.fill(0);
		cellCount.fill(0);
		const cols = c.cols;
		const rows = c.rows;
		const invAspect = 1 / aspect;
		const SPLAT_R2 = 1.6;
		const NORM = 0.55;
		const KB = NORM / SPLAT_R2;
		for (let i = 0; i < n; i++) {
			const cx = px[i];
			const cy = py[i] * invAspect;
			const x0 = Math.floor(cx - 1);
			const x1 = Math.floor(cx + 1);
			const y0 = Math.floor(cy - 1);
			const y1 = Math.floor(cy + 1);
			for (let yi = y0; yi <= y1; yi++) {
				if (yi < 0 || yi >= rows) continue;
				const ey = (yi + 0.5 - cy) * aspect;
				const ey2 = ey * ey;
				const off = yi * cols;
				for (let xi = x0; xi <= x1; xi++) {
					if (xi < 0 || xi >= cols) continue;
					const ex = xi + 0.5 - cx;
					const r2 = ex * ex + ey2;
					if (r2 < SPLAT_R2) {
						density[off + xi] += NORM - r2 * KB;
					}
				}
			}
			// Velocity accumulates once per particle at its nearest cell — cheaper
			// than weighting across the full splat kernel, and we only need a
			// dominant direction per cell, not a smooth vector field.
			const hxi = cx | 0;
			const hyi = (py[i] * invAspect) | 0;
			if (hxi >= 0 && hxi < cols && hyi >= 0 && hyi < rows) {
				const h = hyi * cols + hxi;
				cellVX[h] += vx[i];
				cellVY[h] += vy[i];
				cellCount[h]++;
			}
		}

		// --- wake: line-splat density from each fast particle's previous-frame
		// position forward to its current position. Multi-point deposit turns
		// inter-frame motion into a visible streak rather than a single dot. ---
		if (!prevPosReady) {
			for (let i = 0; i < n; i++) {
				prevPx[i] = px[i];
				prevPy[i] = py[i];
			}
			prevPosReady = true;
		} else {
			const WAKE_DISP2 = 0.2 * 0.2;
			const WAKE_HEAD = 0.9; // weight at prev position (strongest)
			const WAKE_TAIL = 0.35; // weight near current position (fades toward main splat)
			for (let i = 0; i < n; i++) {
				const dpx = px[i] - prevPx[i];
				const dpy = py[i] - prevPy[i];
				const d2 = dpx * dpx + dpy * dpy;
				if (d2 < WAKE_DISP2) continue;
				// one step per ~0.6 sim-unit of motion, capped so very fast particles
				// don't blow up the inner loop
				const dist = Math.sqrt(d2);
				const steps = Math.min(6, Math.max(2, (dist * 1.6) | 0));
				for (let s = 0; s < steps; s++) {
					const t = s / (steps - 1);
					const wx = prevPx[i] + dpx * t;
					const wy = prevPy[i] + dpy * t;
					const wxi = wx | 0;
					const wyi = (wy * invAspect) | 0;
					if (wxi < 0 || wxi >= cols || wyi < 0 || wyi >= rows) continue;
					// head (t=0) → WAKE_HEAD, tail (t=1) → WAKE_TAIL, linear
					const w = WAKE_HEAD + (WAKE_TAIL - WAKE_HEAD) * t;
					density[wyi * cols + wxi] += w;
				}
			}
		}

		// Afterimage: subtle carryover so the wake-deposits from prior frames
		// linger briefly. Lower decay than before — user wants less overall blur.
		const DECAY = 0.5;
		for (let i = 0; i < density.length; i++) {
			const prev = prevDensity[i] * DECAY;
			if (prev > density[i]) density[i] = prev;
			prevDensity[i] = density[i];
		}

		c.fieldArr(density, RAMP, '#6cd6ff', '#020814');

		// --- body break-up pass: override the solid slab with keyboard glyphs
		// that carry information. Flowing cells get `=` / `|` / `/` / `\`
		// keyed to velocity direction; calm dense cells get a slowly-drifting
		// "#"/"%" checker. Same fg as body → uniform render path intact.
		//
		// Flicker control:
		//   - per-cell direction is EMA-smoothed against its prev-frame value
		//     so mid-angle cells don't flip glyphs every frame
		//   - 4-way bucketing via |vx| vs |vy| ratio (no atan2) — no oscillation
		//     at bucket boundaries
		//   - checker phase advances slowly (≈2 Hz) instead of ≈7 Hz ---
		const bodyFg = c.color('#6cd6ff');
		const bodyBg = c.color('#020814');
		const FLOW_DENSITY = 0.62;
		const CALM_MAG = 0.28; // below this smoothed-unit-speed proxy → calm
		const DIR_SMOOTH = 0.7; // EMA weight on prev direction (higher = stickier)
		const CHAR_HASH = 35;  // '#'  horizontal flow (dense, no vertical-gap striping)
		const CHAR_PIPE = 124; // '|' vertical flow
		const CHAR_FWD = 47;  // '/'  diag ↗ (or ↙)
		const CHAR_BWD = 92;  // '\'  diag ↘ (or ↖)
		const CHAR_AT = 64;     // '@'  calm checker A
		const CHAR_DOLLAR = 36; // '$'  calm checker B
		const phase = (c.frame >> 5) & 1;
		for (let yi = 0; yi < rows; yi++) {
			const rowOff = yi * cols;
			for (let xi = 0; xi < cols; xi++) {
				const idx = rowOff + xi;
				if (density[idx] < FLOW_DENSITY) continue;
				const cnt = cellCount[idx];
				let dirX = smoothDirX[idx];
				let dirY = smoothDirY[idx];
				if (cnt > 0) {
					const avx = cellVX[idx] / cnt;
					const avy = cellVY[idx] / cnt;
					// normalize to unit direction, scaled by a soft speed factor
					// (tanh-ish: small speeds contribute less) so calm cells
					// relax toward zero magnitude over time.
					const mag = Math.sqrt(avx * avx + avy * avy);
					const soft = mag / (mag + 20); // 0..1, 20 sim/s is "50%"
					const nx = mag > 1e-4 ? (avx / mag) * soft : 0;
					const ny = mag > 1e-4 ? (avy / mag) * soft : 0;
					dirX = dirX * DIR_SMOOTH + nx * (1 - DIR_SMOOTH);
					dirY = dirY * DIR_SMOOTH + ny * (1 - DIR_SMOOTH);
				} else {
					// no particles here this frame — decay toward zero
					dirX *= DIR_SMOOTH;
					dirY *= DIR_SMOOTH;
				}
				smoothDirX[idx] = dirX;
				smoothDirY[idx] = dirY;

				const absX = Math.abs(dirX);
				const absY = Math.abs(dirY);
				let ch: number;
				if (absX < CALM_MAG && absY < CALM_MAG) {
					ch = ((xi + yi + phase) & 1) ? CHAR_AT : CHAR_DOLLAR;
				} else if (absX > absY * 2) {
					ch = CHAR_HASH;
				} else if (absY > absX * 2) {
					ch = CHAR_PIPE;
				} else {
					// mixed → diagonal. same-sign (both +, both −) reads as ↘/↖ → '\'
					// opposite-sign reads as ↗/↙ → '/'
					ch = dirX * dirY >= 0 ? CHAR_BWD : CHAR_FWD;
				}
				c.setI(xi, yi, ch, bodyFg, bodyBg);
			}
		}

		// --- bubble cells: low-density holes inside dense water show as "o"/"O".
		// Adds texture to the interior and leverages ASCII glyph shape directly. ---
		const BUBBLE_HOLE = 0.15;
		const BUBBLE_NEIGH = 0.7;
		const CHAR_o = 111;
		const CHAR_O = 79;
		for (let yi = 1; yi < rows - 1; yi++) {
			const rowOff = yi * cols;
			for (let xi = 1; xi < cols - 1; xi++) {
				const idx = rowOff + xi;
				const d = density[idx];
				if (d > BUBBLE_HOLE) continue;
				const up = density[idx - cols];
				const dn = density[idx + cols];
				const lf = density[idx - 1];
				const rt = density[idx + 1];
				if (up < BUBBLE_NEIGH || dn < BUBBLE_NEIGH || lf < BUBBLE_NEIGH || rt < BUBBLE_NEIGH) continue;
				// bigger glyph when the hole is deeper
				const ch = d < 0.04 ? CHAR_O : CHAR_o;
				c.setI(xi, yi, ch, bodyFg, bodyBg);
			}
		}

		// Sparse foam overlay — fastest surface particles rendered as whitecaps.
		// Cap count to stay in the "few hundred cells" budget that keeps overlays
		// cheap on top of the uniform density pass.
		const FOAM_SPEED2 = 55 * 55;
		const FOAM_MAX = 220;
		const SURFACE_DENSITY = 0.45;
		const foamFg = c.color('#f0faff');
		let foamCount = 0;
		for (let i = 0; i < n && foamCount < FOAM_MAX; i++) {
			const svx = vx[i];
			const svy = vy[i];
			const s2 = svx * svx + svy * svy;
			if (s2 < FOAM_SPEED2) continue;
			const xi = px[i] | 0;
			const yi = (py[i] * invAspect) | 0;
			if (xi < 0 || xi >= cols || yi < 0 || yi >= rows) continue;
			if (density[yi * cols + xi] > SURFACE_DENSITY) continue;
			let ch: number;
			if (s2 > 110 * 110) ch = 34; // "
			else if (s2 > 80 * 80) ch = 42; // *
			else ch = 39; // '
			c.setI(xi, yi, ch, foamFg, bodyBg);
			foamCount++;
		}

		// --- cursor brackets — "(" on the left and ")" on the right of the mouse
		// cell, flanking the active repel zone. Only drawn when cursor is inside. ---
		if (mInside) {
			const cxi = c.mouse.x;
			const cyi = c.mouse.y;
			const cursorFg = c.color('#f0faff');
			if (cxi - 1 >= 0) c.setI(cxi - 1, cyi, 40, cursorFg, bodyBg); // (
			if (cxi + 1 < cols) c.setI(cxi + 1, cyi, 41, cursorFg, bodyBg); // )
		}

		// update previous positions for next-frame wake deposit
		for (let i = 0; i < n; i++) {
			prevPx[i] = px[i];
			prevPy[i] = py[i];
		}

		c.text(0, 0, Math.round(c.fps) + ' FPS', '#9ab', '#020814');
	}
</script>

<AsciiCanvas {effect} />

{#if needsPermission}
	<button class="perm" onclick={requestMotionPermission}>Enable tilt</button>
{/if}
{#if permissionError}
	<div class="err">{permissionError}</div>
{/if}

<style>
	.perm {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		padding: 1rem 1.5rem;
		background: #6cd6ff;
		color: #020814;
		border: none;
		font-family: monospace;
		font-size: 1rem;
		cursor: pointer;
		z-index: 10;
	}
	.err {
		position: fixed;
		bottom: 1rem;
		left: 1rem;
		color: #ff6c6c;
		font-family: monospace;
		z-index: 10;
	}
</style>
