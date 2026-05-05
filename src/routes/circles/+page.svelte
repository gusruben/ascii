<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	function effect(c: AsciiApi) {
		const cx = c.cols / 2;
		const cy = c.rows / 2;
		const t = c.elapsed * 2;
		const aspect = c.cellAspect;

		c.field((x, y) => {
			const dx = x - cx;
			const dy = (y - cy) * aspect;
			const d = Math.sqrt(dx * dx + dy * dy);
			return (Math.sin(d * 0.25 - t) + 1) * 0.5;
		});

		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
