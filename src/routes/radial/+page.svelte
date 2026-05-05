<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Inspired by the flowing ASCII background on https://ertdfgcvb.xyz/
	// (Andreas Gysin). Interference of a radial ripple and a skewed plane
	// wave, sampled through a wide density ramp.
	const RAMP = ' .,:;i1tfLCG08@';

	function effect(c: AsciiApi) {
		const cx = c.cols / 2;
		const cy = c.rows / 2;
		const a = c.cellAspect;
		const t = c.elapsed;

		c.field((x, y) => {
			const dx = (x - cx) * 0.5;
			const dy = (y - cy) * 0.5 * a;
			const d = Math.sqrt(dx * dx + dy * dy);

			const s1 = Math.sin(d * 0.5 - t * 1.8);
			const s2 = Math.sin(dx * 0.18 + dy * 0.12 + t * 0.9);
			const s3 = Math.cos((dx - dy) * 0.09 - t * 0.6);

			return (s1 + s2 + s3 + 3) / 6;
		}, RAMP);

		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
