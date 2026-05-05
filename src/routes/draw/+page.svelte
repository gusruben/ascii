<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	type P = {
		// Sub-cell (braille) coords: px in [0, cols*2), py in [0, rows*4)
		px: number;
		py: number;
		vx: number;
		vy: number;
		age: number;
		life: number;
		seed: number;
		// initial heading of the stroke at spawn time, radians
		stroke: number;
	};

	const particles: P[] = [];
	const MAX_PARTICLES = 5000;

	let drawing = false;
	let strokeAng = 0;

	// Ordered samples of the in-progress stroke. We smooth between them with
	// Catmull-Rom so that under lag — when pointer samples are further apart —
	// the rendered path stays curved instead of turning into visible polygons.
	type S = { px: number; py: number };
	const stroke: S[] = [];
	// Index of the last sample whose *incoming* segment has been emitted as
	// particles. We only emit a segment once both its endpoints AND at least
	// one forward neighbor exist, so the spline has a real tangent at p2.
	let drawnUpTo = -1;
	let cols = 1;
	let rows = 1;

	function sampleFrom(clientX: number, clientY: number) {
		const pre = document.querySelector('pre');
		if (!pre) return;
		const r = pre.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return;
		const fx = ((clientX - r.left) / r.width) * cols;
		const fy = ((clientY - r.top) / r.height) * rows;
		stroke.push({ px: fx * 2, py: fy * 4 });
	}

	function onMove(e: PointerEvent) {
		if (!drawing) return;
		const coalesced =
			typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
		if (coalesced && coalesced.length > 0) {
			for (const ce of coalesced) sampleFrom(ce.clientX, ce.clientY);
		} else {
			sampleFrom(e.clientX, e.clientY);
		}
	}

	function spawnAt(px: number, py: number) {
		if (particles.length >= MAX_PARTICLES) return;
		particles.push({
			px,
			py,
			vx: 0,
			vy: 0,
			age: 0,
			life: 1.4 + Math.random() * 2.0,
			seed: Math.random() * 1000,
			stroke: strokeAng
		});
	}

	// Catmull-Rom spline through p1..p2 with p0,p3 as tangent controls. Tension
	// 0.5 (standard centripetal-ish). Returns the interpolated point.
	function cr(p0: S, p1: S, p2: S, p3: S, t: number, out: S) {
		const t2 = t * t;
		const t3 = t2 * t;
		out.px =
			0.5 *
			(2 * p1.px +
				(-p0.px + p2.px) * t +
				(2 * p0.px - 5 * p1.px + 4 * p2.px - p3.px) * t2 +
				(-p0.px + 3 * p1.px - 3 * p2.px + p3.px) * t3);
		out.py =
			0.5 *
			(2 * p1.py +
				(-p0.py + p2.py) * t +
				(2 * p0.py - 5 * p1.py + 4 * p2.py - p3.py) * t2 +
				(-p0.py + 3 * p1.py - 3 * p2.py + p3.py) * t3);
	}

	// Scratch objects reused per segment, no allocation in the hot loop.
	const scratch: S = { px: 0, py: 0 };
	const prev: S = { px: 0, py: 0 };

	// Emit particles along the Catmull-Rom curve from stroke[i] to stroke[i+1].
	// Requires stroke[i+2] to exist for a real forward tangent.
	function emitSegment(i: number, maxGap: number) {
		const p0 = stroke[i - 1] ?? stroke[i];
		const p1 = stroke[i];
		const p2 = stroke[i + 1];
		const p3 = stroke[i + 2] ?? p2;

		// If the chord is huge (teleport / tab switch), don't draw a streak.
		const chord = Math.hypot(p2.px - p1.px, p2.py - p1.py);
		if (chord > maxGap) {
			spawnAt(p2.px, p2.py);
			return;
		}

		// Sample density: enough to look continuous even on long curves.
		const steps = Math.max(2, Math.ceil(chord * 1.0) + 2);
		prev.px = p1.px;
		prev.py = p1.py;
		for (let k = 1; k <= steps; k++) {
			const t = k / steps;
			cr(p0, p1, p2, p3, t, scratch);
			const dx = scratch.px - prev.px;
			const dy = scratch.py - prev.py;
			if (dx !== 0 || dy !== 0) strokeAng = Math.atan2(dy, dx);
			const nx = -Math.sin(strokeAng);
			const ny = Math.cos(strokeAng);
			const j = (Math.random() - 0.5) * 0.5;
			spawnAt(scratch.px + nx * j, scratch.py + ny * j);
			prev.px = scratch.px;
			prev.py = scratch.py;
		}
	}

	function onDown(e: PointerEvent) {
		if (e.button !== undefined && e.button !== 0) return;
		drawing = true;
		stroke.length = 0;
		drawnUpTo = -1;
		sampleFrom(e.clientX, e.clientY);
	}
	function onUp() {
		if (!drawing) return;
		drawing = false;
		// Flush any remaining un-emitted segments using the last sample as its
		// own forward control so the stroke ends where the user lifted.
		const maxGap = Math.hypot(cols * 2, rows * 4) * 0.4;
		while (drawnUpTo + 1 < stroke.length - 1) {
			emitSegment(drawnUpTo + 1, maxGap);
			drawnUpTo++;
		}
		// The very last segment (no forward neighbor) — emit with p3=p2.
		if (stroke.length >= 2 && drawnUpTo < stroke.length - 1) {
			emitSegment(drawnUpTo + 1, maxGap);
			drawnUpTo = stroke.length - 1;
		}
		stroke.length = 0;
		drawnUpTo = -1;
	}

	const DUST = '•∙*✦✧⋆+';
	const DRIFT = "·'~˙";
	const FAINT = ".'·";

	function effect(c: AsciiApi) {
		cols = c.cols;
		rows = c.rows;
		const dt = Math.min(c.dt, 0.05);

		// Emit any stroke segments whose forward neighbor has arrived. We hold
		// off on the latest segment (drawnUpTo+1 == stroke.length-1) so its
		// Catmull-Rom tangent can be computed from a real p3 — releasing it
		// early would re-introduce the straight-polygon look at the leading
		// edge of the stroke.
		if (drawing && stroke.length >= 3) {
			const maxGap = Math.hypot(cols * 2, rows * 4) * 0.4;
			while (drawnUpTo + 2 < stroke.length - 1) {
				emitSegment(drawnUpTo + 1, maxGap);
				drawnUpTo++;
			}
			// One more: the segment whose p3 is the newest sample.
			if (drawnUpTo + 1 < stroke.length - 1) {
				emitSegment(drawnUpTo + 1, maxGap);
				drawnUpTo++;
			}
		}

		c.clear();

		for (let i = particles.length - 1; i >= 0; i--) {
			const p = particles[i];
			p.age += dt;
			const t = p.age / p.life;
			if (t >= 1) {
				particles.splice(i, 1);
				continue;
			}

			if (t < 0.22) {
				// Stage 1: crisp braille dot, bright. Sits still, feels solid.
				c.bset(p.px | 0, p.py | 0, '#ffffff');
				continue;
			}

			// Stage 2+: starts drifting. Assign an escape velocity once.
			if (p.vx === 0 && p.vy === 0) {
				// Break roughly perpendicular to the stroke so lines "unzip"
				const perp = p.stroke + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
				const spread = (Math.random() - 0.5) * 1.2;
				const speed = 2 + Math.random() * 5;
				p.vx = Math.cos(perp + spread) * speed;
				p.vy = Math.sin(perp + spread) * speed - (3 + Math.random() * 3);
			}

			const curl = Math.sin(p.age * 2.3 + p.seed) + Math.cos(p.age * 1.1 + p.seed * 0.7);
			p.vx += curl * dt * 1.8;
			p.vy += -2.5 * dt;
			p.vx *= 1 - dt * 0.35;
			p.vy *= 1 - dt * 0.22;
			p.px += p.vx * dt;
			p.py += p.vy * dt;

			const cx = p.px >> 1;
			const cy = p.py >> 2;
			if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;

			let ch: string;
			let color: string;
			const fi = ((p.seed * 53 + p.age * 11) | 0) & 0x7fffffff;

			if (t < 0.5) {
				ch = DUST[fi % DUST.length];
				const k = (t - 0.22) / 0.28;
				const hue = 52 - k * 40;
				const l = 0.68 - k * 0.18;
				color = c.hslQ(hue, 0.85, l, 12);
			} else if (t < 0.78) {
				ch = DRIFT[fi % DRIFT.length];
				const k = (t - 0.5) / 0.28;
				const hue = 12 - k * 12;
				const l = 0.5 - k * 0.2;
				color = c.hslQ(hue, 0.6, Math.max(0.15, l), 12);
			} else {
				ch = FAINT[fi % FAINT.length];
				const k = (t - 0.78) / 0.22;
				const l = 0.3 * (1 - k);
				color = c.hslQ(220, 0.3, Math.max(0.08, l), 12);
			}
			c.set(cx, cy, ch, color);
		}

		c.text(0, 0, `${Math.round(c.fps)} FPS`, '#666666');
	}
</script>

<svelte:window
	onpointerdown={onDown}
	onpointerup={onUp}
	onpointercancel={onUp}
	onpointermove={onMove}
/>
<AsciiCanvas {effect} selectable={false} />
