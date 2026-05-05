// Helpers shared by the /bench/* stress demos.
//
// Each demo reads scalar query-string params (intensity / count / size /
// extra) and emits a single `[bench-ready]` console log on its first frame.
// The Playwright harness keys off both — query string for the input
// configuration, the log for "first paint happened, start measuring".

export function benchParam(name: string, fallback: number): number {
	if (typeof location === 'undefined') return fallback;
	const v = new URLSearchParams(location.search).get(name);
	if (v == null) return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

export function benchReady(c: { frame: number }): void {
	if (c.frame === 1) {
		// One log per page load. The runtime's first-frame timing log fires
		// on the rAF after first paint; this fires inside the first effect
		// call, which is close enough for the harness's start-of-measure
		// gate (a 30-frame warmup follows anyway).
		// eslint-disable-next-line no-console
		console.log('[bench-ready]');
	}
}
