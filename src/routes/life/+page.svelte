<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	const UPPER = '▀';
	const LOWER = '▄';
	const FULL = '█';
	const SPACE = ' ';

	let W = 0;
	let H = 0;
	let cur = new Uint8Array(0);
	let next = new Uint8Array(0);
	let paused = false;
	let stepAccum = 0;
	let mouseDown = false;
	const STEP_HZ = 20;

	$effect(() => {
		const down = (e: MouseEvent) => {
			if (e.button === 0) mouseDown = true;
		};
		const up = (e: MouseEvent) => {
			if (e.button === 0) mouseDown = false;
		};
		window.addEventListener('mousedown', down);
		window.addEventListener('mouseup', up);
		return () => {
			window.removeEventListener('mousedown', down);
			window.removeEventListener('mouseup', up);
		};
	});

	function reseed() {
		for (let i = 0; i < cur.length; i++) cur[i] = Math.random() < 0.3 ? 1 : 0;
	}

	function resize(w: number, h: number) {
		W = w;
		H = h;
		cur = new Uint8Array(W * H);
		next = new Uint8Array(W * H);
		reseed();
	}

	function step() {
		for (let y = 0; y < H; y++) {
			const ym = y === 0 ? H - 1 : y - 1;
			const yp = y === H - 1 ? 0 : y + 1;
			for (let x = 0; x < W; x++) {
				const xm = x === 0 ? W - 1 : x - 1;
				const xp = x === W - 1 ? 0 : x + 1;
				const n =
					cur[ym * W + xm] + cur[ym * W + x] + cur[ym * W + xp] +
					cur[y * W + xm] + cur[y * W + xp] +
					cur[yp * W + xm] + cur[yp * W + x] + cur[yp * W + xp];
				const a = cur[y * W + x];
				next[y * W + x] = n === 3 || (a && n === 2) ? 1 : 0;
			}
		}
		const tmp = cur;
		cur = next;
		next = tmp;
	}

	function paintAt(px: number, py: number) {
		if (px < 0 || px >= W || py < 0 || py >= H) return;
		cur[py * W + px] = 1;
	}

	function draw(c: AsciiApi) {
		const needW = c.cols;
		const needH = c.rows * 2;
		if (needW !== W || needH !== H) resize(needW, needH);

		if (c.keys.justPressed(' ')) paused = !paused;
		if (c.keys.justPressed('r') || c.keys.justPressed('R')) reseed();
		if (c.keys.justPressed('c') || c.keys.justPressed('C')) cur.fill(0);

		if (mouseDown) {
			const gx = Math.floor(c.mouse.fx);
			const gy = Math.floor(c.mouse.fy * 2);
			paintAt(gx, gy);
		}

		if (!paused) {
			stepAccum += c.dt;
			const period = 1 / STEP_HZ;
			let safety = 4;
			while (stepAccum >= period && safety-- > 0) {
				step();
				stepAccum -= period;
			}
		}

		for (let y = 0; y < c.rows; y++) {
			const rowTop = y * 2;
			const rowBot = rowTop + 1;
			for (let x = 0; x < c.cols; x++) {
				const t = cur[rowTop * W + x];
				const b = cur[rowBot * W + x];
				const ch = t && b ? FULL : t ? UPPER : b ? LOWER : SPACE;
				c.set(x, y, ch);
			}
		}

		const hud = c.cols >= 60
			? `${Math.round(c.fps)} FPS  ${paused ? '[PAUSED]' : ''}  space=pause  r=reseed  c=clear`
			: `${Math.round(c.fps)} FPS`;
		c.text(0, 0, hud);
	}
</script>

<AsciiCanvas effect={draw} selectable={false} />
