<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Mouse-reactive variant of /radial. Two interactions compose:
	//  1. The radial origin eases toward the cursor (fast sweeps whip it around).
	//  2. Moving the cursor far enough spawns decaying ripples, so quick gestures
	//     leave a visible wake even after the mouse stops.
	const RAMP = ' .,:;i1tfLCG08@';
	const MAX_RIPPLES = 12;

	type Ripple = { x: number; y: number; t0: number };
	const ripples: Ripple[] = Array.from({ length: MAX_RIPPLES }, () => ({ x: 0, y: 0, t0: -1 }));
	let writeIdx = 0;

	let rx = -1;
	let ry = -1;
	let lastSpawnX = -Infinity;
	let lastSpawnY = -Infinity;
	let mouseSeen = false;

	function effect(c: AsciiApi) {
		const t = c.elapsed;
		const dt = c.dt || 1 / 60;
		const a = c.cellAspect;

		if (rx < 0) {
			rx = c.cols / 2;
			ry = c.rows / 2;
		}

		const mx = c.mouse.fx;
		const my = c.mouse.fy;
		if (!mouseSeen && (mx !== 0 || my !== 0 || c.mouse.x !== c.mouse.px)) mouseSeen = true;

		// Ease origin toward cursor, frame-rate independent.
		const k = 1 - Math.exp(-dt * 4);
		const tgtX = mouseSeen ? mx : c.cols / 2;
		const tgtY = mouseSeen ? my : c.rows / 2;
		rx += (tgtX - rx) * k;
		ry += (tgtY - ry) * k;

		// Spawn a ripple every few aspect-corrected units of travel.
		if (mouseSeen) {
			const ddx = (mx - lastSpawnX) * 0.5;
			const ddy = (my - lastSpawnY) * 0.5 * a;
			if (ddx * ddx + ddy * ddy > 9) {
				const r = ripples[writeIdx];
				r.x = mx;
				r.y = my;
				r.t0 = t;
				writeIdx = (writeIdx + 1) % MAX_RIPPLES;
				lastSpawnX = mx;
				lastSpawnY = my;
			}
		}

		c.field((x, y) => {
			const dx = (x - rx) * 0.5;
			const dy = (y - ry) * 0.5 * a;
			const d = Math.sqrt(dx * dx + dy * dy);

			const s1 = Math.sin(d * 0.5 - t * 1.8);
			const s2 = Math.sin(dx * 0.18 + dy * 0.12 + t * 0.9);
			const s3 = Math.cos((dx - dy) * 0.09 - t * 0.6);
			let sum = s1 + s2 + s3;

			for (let i = 0; i < MAX_RIPPLES; i++) {
				const r = ripples[i];
				if (r.t0 < 0) continue;
				const age = t - r.t0;
				if (age > 3.5) {
					r.t0 = -1;
					continue;
				}
				const rdx = (x - r.x) * 0.5;
				const rdy = (y - r.y) * 0.5 * a;
				const rd = Math.sqrt(rdx * rdx + rdy * rdy);
				const decay = Math.exp(-age * 0.9);
				sum += Math.sin(rd * 0.8 - age * 4) * decay * 1.2;
			}

			return (sum + 5) / 10;
		}, RAMP);

		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
