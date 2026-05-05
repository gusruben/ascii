<script lang="ts">
	import { AsciiCanvas, type AsciiApi } from '$lib/ascii';

	// Classic donut.c: torus swept by (theta, phi), rotated by (A, B),
	// projected with a simple z-buffer, shaded by Lambertian luminance.
	const RAMP = '.,-~:;=!*#$@';
	const R1 = 1; // tube radius
	const R2 = 2; // torus radius
	const K2 = 5; // camera distance

	let zbuf: Float32Array | null = null;
	let lbuf: Float32Array | null = null;

	function effect(c: AsciiApi) {
		const w = c.cols;
		const h = c.rows;
		const n = w * h;
		if (!zbuf || zbuf.length !== n) {
			zbuf = new Float32Array(n);
			lbuf = new Float32Array(n);
		}
		zbuf.fill(0);
		lbuf!.fill(-1);

		c.fill(' ');

		// Fit the donut to the viewport. Cells are ~twice as tall as wide,
		// so scale y by 1/cellAspect to keep the donut round.
		const aspect = c.cellAspect;
		const K1 = (Math.min(w, h * aspect) * K2) / (3 * (R1 + R2));

		const A = c.elapsed * 1.0;
		const B = c.elapsed * 0.6;
		const cA = Math.cos(A), sA = Math.sin(A);
		const cB = Math.cos(B), sB = Math.sin(B);

		const cx = w / 2;
		const cy = h / 2;

		// theta sweeps the cross-section circle, phi sweeps around the torus.
		const dTheta = 0.03;
		const dPhi = 0.008;

		for (let theta = 0; theta < Math.PI * 2; theta += dTheta) {
			const cT = Math.cos(theta), sT = Math.sin(theta);
			for (let phi = 0; phi < Math.PI * 2; phi += dPhi) {
				const cP = Math.cos(phi), sP = Math.sin(phi);

				const circleX = R2 + R1 * cT;
				const circleY = R1 * sT;

				// Rotate around Y then X.
				const x = circleX * (cB * cP + sA * sB * sP) - circleY * cA * sB;
				const y = circleX * (sB * cP - sA * cB * sP) + circleY * cA * cB;
				const z = K2 + cA * circleX * sP + circleY * sA;
				const ooz = 1 / z;

				const sx = Math.floor(cx + K1 * ooz * x);
				const sy = Math.floor(cy - (K1 * ooz * y) / aspect);

				if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;

				// Lambertian lighting, light from (0, 1, -1).
				const L =
					cP * cT * sB -
					cA * cT * sP -
					sA * sT +
					cB * (cA * sT - cT * sA * sP);

				if (L <= 0) continue;

				const idx = sy * w + sx;
				if (ooz > zbuf[idx]) {
					zbuf[idx] = ooz;
					lbuf![idx] = L;
				}
			}
		}

		for (let i = 0; i < n; i++) {
			const L = lbuf![i];
			if (L < 0) continue;
			const ri = Math.min(RAMP.length - 1, Math.floor(L * 8));
			const x = i % w;
			const y = (i / w) | 0;
			c.set(x, y, RAMP[ri]);
		}

		c.text(0, 0, Math.round(c.fps) + ' FPS');
	}
</script>

<AsciiCanvas {effect} />
