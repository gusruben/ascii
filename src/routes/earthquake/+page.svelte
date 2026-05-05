<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';
	import { stripComments } from '$lib/quineSource';
	import { onMount } from 'svelte';
	import selfSourceRaw from './+page.svelte?raw';

	// Token earthquake (quine). The page's own source — comments stripped —
	// is split into tokens (identifiers, numbers, strings, single-char
	// punct). Each token is a rigid body whose characters move together,
	// anchored to its original source position by a stiff spring.
	//
	// Three forces hit a token:
	//   - radial repel from the cursor (strong, falls off quadratically)
	//   - swipe transfer: the cursor's instantaneous velocity is added to
	//     nearby tokens, so a fast pass through the page flings tokens
	//     several cells along the swipe direction
	//   - click impulse: an instantaneous radial velocity kick over a wide
	//     radius, so a click visibly explodes a chunk of source. In
	//     self-demo mode (no real cursor seen yet) the orbit fires its
	//     own click every ~1.5 s so the iframe view shows the explosion.
	//
	// Whitespace is intentionally NOT a token. Inter-token gaps stretch
	// and contract as adjacent tokens swing — code visibly breathes
	// around the cursor instead of just rocking in place.

	const selfSource = stripComments(selfSourceRaw);

	type Token = {
		text: string;
		ax: number;
		ay: number;
		px: number;
		py: number;
		vx: number;
		vy: number;
	};

	function tokenize(src: string): Token[] {
		const out: Token[] = [];
		const lines = src.split('\n');
		const isAlpha = (cc: number) =>
			(cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 95 || cc === 36;
		const isDigit = (cc: number) => cc >= 48 && cc <= 57;
		const isAlphaNum = (cc: number) => isAlpha(cc) || isDigit(cc);
		for (let row = 0; row < lines.length; row++) {
			const line = lines[row];
			let i = 0;
			while (i < line.length) {
				const ch = line.charCodeAt(i);
				if (ch <= 32) {
					i++;
					continue;
				}
				let j = i + 1;
				if (isAlpha(ch)) {
					while (j < line.length && isAlphaNum(line.charCodeAt(j))) j++;
				} else if (isDigit(ch)) {
					while (
						j < line.length &&
						(isDigit(line.charCodeAt(j)) || line.charCodeAt(j) === 46)
					)
						j++;
				} else if (ch === 34 || ch === 39 || ch === 96) {
					while (j < line.length && line.charCodeAt(j) !== ch) {
						if (line.charCodeAt(j) === 92) j++;
						j++;
					}
					if (j < line.length) j++;
				}
				out.push({
					text: line.slice(i, j),
					ax: i,
					ay: row,
					px: i,
					py: row,
					vx: 0,
					vy: 0
				});
				i = j;
			}
		}
		return out;
	}

	let tokens: Token[] | null = null;
	let lastCols = 1;
	let lastRows = 1;
	let pendingExplosion: { x: number; y: number } | null = null;
	let mouseSeen = false;
	let frames = 0;
	let prevMx = 0;
	let prevMy = 0;
	let prevMouseInit = false;

	onMount(() => {
		const onDown = (e: MouseEvent) => {
			if (e.button !== 0) return;
			const pre = document.querySelector('pre');
			if (!pre) return;
			const r = pre.getBoundingClientRect();
			if (r.width <= 0) return;
			const x = ((e.clientX - r.left) / r.width) * lastCols;
			const y = ((e.clientY - r.top) / r.height) * lastRows;
			pendingExplosion = { x, y };
		};
		window.addEventListener('mousedown', onDown);
		return () => window.removeEventListener('mousedown', onDown);
	});

	// Tuning. v1 was timid — a slow hover only bobbed a couple of cells. v2
	// numbers below give: visible disturbance from a slow hover, a fling
	// from a fast swipe, and a wide explosion from a click.
	const SPRING_K = 30;
	const DAMP_RATE = 5; // velocity decays by 1/e in ~0.2 s
	const PUSH_R = 12;
	const PUSH_FORCE = 5500;
	const SWIPE_GAIN = 55; // velocity transfer rate (1/s)
	const EXPLOSION_R = 18;
	const EXPLOSION_PEAK_V = 95; // instantaneous radial velocity (cells/s) at center
	const MAX_V = 160;

	function effect(c: AsciiApi) {
		if (!tokens) tokens = tokenize(selfSource);

		const W = c.cols;
		const H = c.rows;
		const aspect = c.cellAspect;
		const dt = Math.min(c.dt || 1 / 60, 1 / 30);
		lastCols = W;
		lastRows = H;

		if (c.mouse.x !== 0 || c.mouse.y !== 0) mouseSeen = true;
		let mx: number;
		let my: number;
		if (mouseSeen) {
			mx = c.mouse.fx;
			my = c.mouse.fy;
		} else {
			const z = frames / 30;
			mx = W * 0.5 + Math.sin(z) * W * 0.42;
			my = H * 0.5 + Math.cos(z * 1.41) * H * 0.42;
			// Self-demo explosions so the iframe view shows the dramatic
			// behavior without requiring user interaction.
			if (frames > 0 && frames % 90 === 0) pendingExplosion = { x: mx, y: my };
		}

		if (!prevMouseInit) {
			prevMx = mx;
			prevMy = my;
			prevMouseInit = true;
		}
		const mouseVx = (mx - prevMx) / dt;
		const mouseVyV = ((my - prevMy) * aspect) / dt;
		prevMx = mx;
		prevMy = my;

		const myV = my * aspect;
		const exp = pendingExplosion;
		pendingExplosion = null;
		const expR2 = EXPLOSION_R * EXPLOSION_R;
		const pushR2 = PUSH_R * PUSH_R;
		const damp = Math.exp(-DAMP_RATE * dt);

		const toks = tokens!;
		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			const cxV = tok.px + tok.text.length * 0.5;
			const cyV = tok.py * aspect;

			if (exp) {
				const expYV = exp.y * aspect;
				const dx = cxV - exp.x;
				const dy = cyV - expYV;
				const d2 = dx * dx + dy * dy;
				if (d2 < expR2 && d2 > 1e-3) {
					const dist = Math.sqrt(d2);
					const w = 1 - dist / EXPLOSION_R;
					const v = EXPLOSION_PEAK_V * w * w;
					const inv = v / dist;
					tok.vx += dx * inv;
					tok.vy += (dy * inv) / aspect;
				}
			}

			const dxr = cxV - mx;
			const dyr = cyV - myV;
			const d2 = dxr * dxr + dyr * dyr;
			if (d2 < pushR2 && d2 > 1e-3) {
				const dist = Math.sqrt(d2);
				const w = 1 - dist / PUSH_R;
				const w2 = w * w;
				const f = (PUSH_FORCE * w2) / dist;
				tok.vx += (dxr * f + mouseVx * SWIPE_GAIN * w2) * dt;
				tok.vy += ((dyr * f + mouseVyV * SWIPE_GAIN * w2) * dt) / aspect;
			}

			const v2 = tok.vx * tok.vx + tok.vy * tok.vy * aspect * aspect;
			if (v2 > MAX_V * MAX_V) {
				const k = MAX_V / Math.sqrt(v2);
				tok.vx *= k;
				tok.vy *= k;
			}

			const sx = (tok.ax - tok.px) * SPRING_K;
			const sy = (tok.ay - tok.py) * SPRING_K;
			tok.vx = (tok.vx + sx * dt) * damp;
			tok.vy = (tok.vy + sy * dt) * damp;
			tok.px += tok.vx * dt;
			tok.py += tok.vy * dt;
		}

		c.fill(' ');
		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			const px = Math.round(tok.px);
			const py = Math.round(tok.py);
			if (py < 0 || py >= H) continue;
			const text = tok.text;
			const len = text.length;
			for (let j = 0; j < len; j++) {
				const xx = px + j;
				if (xx < 0 || xx >= W) continue;
				c.setI(xx, py, text.charCodeAt(j), 0, 1);
			}
		}

		frames++;
		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} selectable={false} />
