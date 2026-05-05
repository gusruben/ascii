import { createAsciiRuntime, type AsciiRuntime } from './runtime';
import type { AsciiApi, Effect } from './types';

/**
 * Harness for driving the ASCII runtime in a happy-dom environment.
 *
 * happy-dom does not do layout, so `getBoundingClientRect()` returns zeros
 * by default — which breaks `measureCell()` and the cols/rows computation.
 * We patch the prototype for the duration of the test: the 100-M probe gets
 * a size that implies `cellW = 8`, and any element tagged with `__testSize`
 * (we set this on the wrap element) reports its configured pixel size.
 *
 * Tests drive frames explicitly: `requestAnimationFrame` is stubbed to a
 * manual queue, so the constructor's auto-scheduled tick never fires on its
 * own. Call `harness.frame(effect)` to run one tick with a given effect.
 */

const CELL_W = 8;
const CELL_H = 16;

export interface Harness {
	api: AsciiApi;
	wrap: HTMLDivElement;
	pre: HTMLPreElement;
	runtime: AsciiRuntime;
	/** Run one frame with the given effect (swaps the effect closure for this tick only). */
	frame(effect?: Effect): void;
	row(j: number): HTMLElement;
	cleanup(): void;
}

interface TestSize {
	w: number;
	h: number;
}

function rect(w: number, h: number): DOMRect {
	return {
		x: 0, y: 0, left: 0, top: 0,
		right: w, bottom: h, width: w, height: h,
		toJSON() { return this; }
	} as DOMRect;
}

let origGBCR: typeof Element.prototype.getBoundingClientRect | null = null;

function installGBCR() {
	if (origGBCR) return;
	origGBCR = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function () {
		const size = (this as unknown as { __testSize?: TestSize }).__testSize;
		if (size) return rect(size.w, size.h);
		// Probe span from measureCell: absolute-positioned, 100 'M's.
		const txt = this.textContent ?? '';
		if (
			this.tagName === 'SPAN' &&
			this.parentElement === document.body &&
			txt.length >= 100 &&
			txt[0] === 'M'
		) {
			return rect(txt.length * CELL_W, CELL_H);
		}
		return rect(0, 0);
	};
}

function restoreGBCR() {
	if (!origGBCR) return;
	Element.prototype.getBoundingClientRect = origGBCR;
	origGBCR = null;
}

interface RafStub {
	flush(t?: number): void;
	restore(): void;
}

function installRafStub(): RafStub {
	const origRaf = globalThis.requestAnimationFrame;
	const origCancel = globalThis.cancelAnimationFrame;
	let queue: FrameRequestCallback[] = [];
	let nextId = 1;
	globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
		queue.push(cb);
		return nextId++;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = (() => {
		// We never re-enter tick after destroy (the runtime's rafId is
		// cancelled); dropping callbacks is fine here because the harness
		// drives frames explicitly via flush().
	}) as typeof cancelAnimationFrame;
	return {
		flush(t = 16) {
			const q = queue;
			queue = [];
			for (const cb of q) cb(t);
		},
		restore() {
			globalThis.requestAnimationFrame = origRaf;
			globalThis.cancelAnimationFrame = origCancel;
		}
	};
}

export function makeHarness(cols = 10, rows = 4): Harness {
	installGBCR();
	const raf = installRafStub();

	const wrap = document.createElement('div');
	const pre = document.createElement('pre');
	wrap.appendChild(pre);
	document.body.appendChild(wrap);
	(wrap as unknown as { __testSize: TestSize }).__testSize = {
		w: cols * CELL_W,
		h: rows * CELL_H
	};

	let currentEffect: Effect = () => {};
	let api!: AsciiApi;
	const forwarder: Effect = (c) => {
		api = c;
		currentEffect(c);
	};

	const runtime = createAsciiRuntime(wrap, pre, forwarder);

	return {
		api,
		wrap,
		pre,
		runtime,
		frame(effect?: Effect) {
			currentEffect = effect ?? (() => {});
			raf.flush();
			currentEffect = () => {};
		},
		row(j) {
			return pre.childNodes[j] as HTMLElement;
		},
		cleanup() {
			runtime.destroy();
			raf.restore();
			if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
			// Leave GBCR patched — restoring between tests is fine, but the
			// next harness call will reinstall it anyway.
			restoreGBCR();
		}
	};
}
