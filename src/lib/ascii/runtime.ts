import {
	BAYER_2, BAYER_4, BAYER_8,
	BORDER_STYLES,
	BRAILLE_BASE, BRAILLE_BITS,
	CH_AMP, CH_GT, CH_LT, CH_SPACE,
	DEFAULT_BG, DEFAULT_FG, DEFAULT_RAMP,
	DEF_BG_IDX, DEF_FG_IDX,
	FONT_FAMILY, FONT_SIZE_PX, LINE_HEIGHT,
	MS_DEFAULT_CHARS
} from './constants';
import { hsl, hslQ, lerpColor, rampChar, rampCodes, rgb, rgbQ } from './colors';
import type {
	AsciiApi, BorderStyle, Cell, DebugBoxOpts, DitherOpts, Effect,
	ProfileApi, ProfileFrameStat, TextBoxOpts
} from './types';

export interface AsciiRuntime {
	api: AsciiApi;
	destroy(): void;
}

/**
 * Wire up an ASCII renderer against the provided wrap/pre elements and run
 * `effect` once per animation frame. Returns the `AsciiApi` in case the caller
 * needs imperative access, plus a `destroy()` cleanup for Svelte onMount.
 */
export interface AsciiRuntimeOptions {
	/**
	 * Mirror touch events onto the `mouse` state so any effect that reads
	 * `c.mouse.*` works on touchscreens without modification. Defaults to
	 * true. Set false if the effect handles touch itself (e.g. multitouch
	 * or a custom gesture model).
	 */
	touch?: boolean;
}

export function createAsciiRuntime(
	wrapEl: HTMLDivElement,
	preEl: HTMLPreElement,
	effect: Effect,
	opts: AsciiRuntimeOptions = {}
): AsciiRuntime {
	const enableTouch = opts.touch !== false;
	// ─── Profile gate ──────────────────────────────────────────────────
	// Enabled either by Vite env (build-time, eliminated by DCE in prod)
	// or by `?profile=1` in the URL. When false, every guarded block is a
	// stable boolean check that V8 inline-caches away.
	const PROFILE_BUILD =
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_ASCII_PROFILE === '1';
	const PROFILE_QUERY =
		typeof location !== 'undefined' && /[?&]profile=1\b/.test(location.search);
	const PROFILE = PROFILE_BUILD || PROFILE_QUERY;

	const profileFrames: ProfileFrameStat[] = [];
	const profile: ProfileApi = {
		get enabled() { return PROFILE; },
		get frames() { return profileFrames; },
		reset() { profileFrames.length = 0; }
	};

	// Per-frame counters mutated inside the path functions.
	let pTextCount = 0, pTextMs = 0;
	let pUniformCount = 0, pUniformMs = 0;
	let pHtmlCount = 0, pHtmlMs = 0;
	let pDirtyRowsRendered = 0;

	// ─── Palette (string → Uint16 index), pre-seeded with defaults ─────
	const paletteStr: string[] = [DEFAULT_FG, DEFAULT_BG];
	const paletteMap = new Map<string, number>([
		[DEFAULT_FG, 0],
		[DEFAULT_BG, 1]
	]);
	const colorIdx = (s: string): number => {
		let v = paletteMap.get(s);
		if (v === undefined) {
			v = paletteStr.length;
			paletteStr.push(s);
			paletteMap.set(s, v);
		}
		return v;
	};

	// ─── Keyboard state ────────────────────────────────────────────────
	const keysDown = new Set<string>();
	const keysPressedThisFrame = new Set<string>();
	const keysApi = {
		isDown: (k: string) => keysDown.has(k),
		justPressed: (k: string) => keysPressedThisFrame.has(k)
	};

	// ─── Renderer state (plain `let` → non-reactive, perf-critical) ────
	let cols = 0;
	let rows = 0;
	let cellW = 0;
	let cellH = 0;

	let chars = new Uint16Array(0);
	let fgIdx = new Uint16Array(0);
	let bgIdx = new Uint16Array(0);
	let backChars = new Uint16Array(0);
	let backFg = new Uint16Array(0);
	let backBg = new Uint16Array(0);

	let dirtyRows = new Uint8Array(0);
	let rowMode = new Uint8Array(0);
	let rowCurFg = new Int32Array(0);
	let rowCurBg = new Int32Array(0);
	let rowEls: HTMLElement[] = [];
	let rowText: (Text | null)[] = [];

	let scratch: string[] = [];

	const preRect = { left: 0, top: 0 };
	const mouse = { x: 0, y: 0, px: 0, py: 0, fx: 0, fy: 0 };
	let elapsed = 0;
	let dt = 0;
	let frame = 0;
	let lastT = 0;
	let rafId = 0;
	let fpsEma = 0;

	// First-frame instrumentation.
	let firstFrameLogged = false;
	const tMount = performance.now();
	let tResizeDone = 0;

	function measureCell(): { w: number; h: number } {
		const probe = document.createElement('span');
		probe.style.cssText = `position:absolute;visibility:hidden;font-family:${FONT_FAMILY};font-size:${FONT_SIZE_PX}px;white-space:pre;line-height:1;`;
		probe.textContent = 'M'.repeat(100);
		document.body.appendChild(probe);
		const rect = probe.getBoundingClientRect();
		const w = rect.width / 100;
		const h = rect.height;
		document.body.removeChild(probe);
		return { w, h };
	}

	function resize() {
		const m = measureCell();
		cellW = m.w;
		cellH = m.h * LINE_HEIGHT;

		const rect = wrapEl.getBoundingClientRect();
		cols = Math.max(4, Math.floor(rect.width / cellW));
		rows = Math.max(4, Math.floor(rect.height / cellH));

		const size = cols * rows;
		chars = new Uint16Array(size);
		fgIdx = new Uint16Array(size);
		bgIdx = new Uint16Array(size);
		backChars = new Uint16Array(size);
		backFg = new Uint16Array(size);
		backBg = new Uint16Array(size);

		chars.fill(CH_SPACE);
		bgIdx.fill(DEF_BG_IDX);
		// Sentinels: back buffer can never equal a real cell, so the first
		// render after resize repaints every row.
		backChars.fill(0xFFFF);
		backFg.fill(0xFFFF);
		backBg.fill(0xFFFF);

		dirtyRows = new Uint8Array(rows);
		dirtyRows.fill(1);
		rowMode = new Uint8Array(rows);
		rowCurFg = new Int32Array(rows).fill(-1);
		rowCurBg = new Int32Array(rows).fill(-1);

		preEl.style.fontFamily = FONT_FAMILY;
		preEl.style.fontSize = `${FONT_SIZE_PX}px`;
		preEl.style.lineHeight = `${cellH}px`;
		preEl.style.width = `${cols * cellW}px`;
		preEl.style.height = `${rows * cellH}px`;

		const prevRowCount = rowEls.length;

		while (preEl.childNodes.length < rows) {
			const row = document.createElement('span');
			row.style.cssText = `display:block;height:${cellH}px;content-visibility:auto;contain-intrinsic-size:${cellW * cols}px ${cellH}px;`;
			row.appendChild(document.createTextNode(''));
			preEl.appendChild(row);
		}
		while (preEl.childNodes.length > rows) {
			preEl.removeChild(preEl.lastChild!);
		}

		// Preserve existing rows' DOM content across resize so the next paint
		// doesn't show a blank frame. New rows get painted by the eager
		// effect() call at the end of this function.
		const newRowEls: HTMLElement[] = new Array(rows);
		const newRowText: (Text | null)[] = new Array(rows);
		const newRowMode = new Uint8Array(rows);
		const newRowCurFg = new Int32Array(rows).fill(-1);
		const newRowCurBg = new Int32Array(rows).fill(-1);

		for (let j = 0; j < rows; j++) {
			const r = preEl.childNodes[j] as HTMLElement;
			newRowEls[j] = r;
			if (j < prevRowCount && rowEls[j] === r) {
				newRowText[j] = rowText[j];
				newRowMode[j] = rowMode[j];
				newRowCurFg[j] = rowCurFg[j];
				newRowCurBg[j] = rowCurBg[j];
			} else {
				newRowText[j] = r.firstChild as Text | null;
			}
		}
		rowEls = newRowEls;
		rowText = newRowText;
		rowMode = newRowMode;
		rowCurFg = newRowCurFg;
		rowCurBg = newRowCurBg;

		if (scratch.length < cols) scratch = new Array(cols);

		const pr = preEl.getBoundingClientRect();
		preRect.left = pr.left;
		preRect.top = pr.top;

		// Eagerly redraw — paired with preserved Text nodes above, prevents
		// blank/stale frames on resize.
		effect(api);
		renderToDOM();
	}

	function rowToString(offs: number, _cols: number): string {
		const s = scratch;
		const _chars = chars;
		for (let i = 0; i < _cols; i++) s[i] = String.fromCharCode(_chars[offs + i]);
		s.length = _cols;
		return s.join('');
	}

	function writeTextPath(
		j: number,
		offs: number,
		_cols: number,
		seenFg: number,
		seenBg: number
	) {
		const t0 = PROFILE ? performance.now() : 0;
		const rowEl = rowEls[j];
		if (rowMode[j] === 1) {
			rowEl.textContent = '';
			const tn = document.createTextNode('');
			rowEl.appendChild(tn);
			rowText[j] = tn;
		}
		if (seenFg === DEF_FG_IDX) {
			if (rowCurFg[j] !== -1) {
				rowEl.style.color = '';
				rowCurFg[j] = -1;
			}
		} else if (rowCurFg[j] !== seenFg) {
			rowEl.style.color = paletteStr[seenFg];
			rowCurFg[j] = seenFg;
		}
		if (seenBg === DEF_BG_IDX) {
			if (rowCurBg[j] !== -1) {
				rowEl.style.background = '';
				rowCurBg[j] = -1;
			}
		} else if (rowCurBg[j] !== seenBg) {
			rowEl.style.background = paletteStr[seenBg];
			rowCurBg[j] = seenBg;
		}
		const s = rowToString(offs, _cols);
		const tn = rowText[j];
		if (tn && tn.parentNode === rowEl) {
			tn.data = s;
		} else {
			rowEl.textContent = s;
			rowText[j] = rowEl.firstChild as Text | null;
		}
		rowMode[j] = 0;
		if (PROFILE) {
			const ms = performance.now() - t0;
			if (seenFg === DEF_FG_IDX && seenBg === DEF_BG_IDX) {
				pTextCount++;
				pTextMs += ms;
			} else {
				pUniformCount++;
				pUniformMs += ms;
			}
		}
	}

	function writeHtmlPath(j: number, offs: number, _cols: number) {
		const t0 = PROFILE ? performance.now() : 0;
		const rowEl = rowEls[j];
		if (rowMode[j] === 0) {
			if (rowCurFg[j] !== -1) {
				rowEl.style.color = '';
				rowCurFg[j] = -1;
			}
			if (rowCurBg[j] !== -1) {
				rowEl.style.background = '';
				rowCurBg[j] = -1;
			}
		}

		const _chars = chars;
		const _fg = fgIdx;
		const _bg = bgIdx;
		const pstr = paletteStr;

		let html = '';
		let curFg = -1;
		let curBg = -1;
		let open = false;

		for (let i = 0; i < _cols; i++) {
			const k = offs + i;
			const f = _fg[k];
			const b = _bg[k];
			const isDefault = f === DEF_FG_IDX && b === DEF_BG_IDX;
			if (isDefault) {
				if (open) {
					html += '</span>';
					open = false;
					curFg = -1;
					curBg = -1;
				}
			} else if (f !== curFg || b !== curBg) {
				if (open) html += '</span>';
				let css = '';
				if (f !== DEF_FG_IDX) css += 'color:' + pstr[f] + ';';
				if (b !== DEF_BG_IDX) css += 'background:' + pstr[b] + ';';
				html += '<span style="' + css + '">';
				open = true;
				curFg = f;
				curBg = b;
			}
			const code = _chars[k];
			if (code === CH_LT) html += '&lt;';
			else if (code === CH_GT) html += '&gt;';
			else if (code === CH_AMP) html += '&amp;';
			else html += String.fromCharCode(code);
		}
		if (open) html += '</span>';
		rowEl.innerHTML = html;
		rowText[j] = null;
		rowMode[j] = 1;
		if (PROFILE) {
			pHtmlCount++;
			pHtmlMs += performance.now() - t0;
		}
	}

	function renderToDOM() {
		const _rows = rows;
		const _cols = cols;
		const _chars = chars;
		const _fg = fgIdx;
		const _bg = bgIdx;
		const _backChars = backChars;
		const _backFg = backFg;
		const _backBg = backBg;
		const _dirty = dirtyRows;

		for (let j = 0; j < _rows; j++) {
			if (!_dirty[j]) continue;
			_dirty[j] = 0;
			const offs = j * _cols;
			let dirty = false;
			let seenFg = -1;
			let seenBg = -1;
			let mixed = false;

			for (let i = 0; i < _cols; i++) {
				const k = offs + i;
				const c = _chars[k];
				const f = _fg[k];
				const b = _bg[k];
				if (_backChars[k] !== c || _backFg[k] !== f || _backBg[k] !== b) {
					dirty = true;
					_backChars[k] = c;
					_backFg[k] = f;
					_backBg[k] = b;
				}
				if (!mixed) {
					if (seenFg === -1) {
						seenFg = f;
						seenBg = b;
					} else if (f !== seenFg || b !== seenBg) {
						mixed = true;
					}
				}
			}
			if (!dirty) continue;
			if (PROFILE) pDirtyRowsRendered++;
			if (!mixed) writeTextPath(j, offs, _cols, seenFg, seenBg);
			else writeHtmlPath(j, offs, _cols);
		}
	}

	// ─── Field helper (shared by api.field / api.fieldRect) ────────────
	function doField(
		x0: number, y0: number, x1: number, y1: number,
		fn: (x: number, y: number) => number,
		ramp: string, fgS: string, bgS: string
	) {
		const codes = rampCodes(ramp);
		const rampLen = codes.length;
		const rampMaxI = rampLen - 1;
		const f = colorIdx(fgS);
		const b = colorIdx(bgS);
		for (let y = y0; y < y1; y++) {
			const off = y * cols;
			for (let x = x0; x < x1; x++) {
				let t = fn(x, y);
				if (t < 0) t = 0;
				else if (t > 1) t = 1;
				const i = t === 1 ? rampMaxI : (t * rampLen) | 0;
				const k = off + x;
				chars[k] = codes[i];
				fgIdx[k] = f;
				bgIdx[k] = b;
			}
			dirtyRows[y] = 1;
		}
	}

	// Single shared Cell returned by api.get / iterated by api.forEach.
	// Callers must not hold the reference or mutate it expecting a write-back
	// — use api.set to write.
	const cellView: Cell = { char: ' ', fg: DEFAULT_FG, bg: DEFAULT_BG };

	const api: AsciiApi = {
		get cols() { return cols; },
		get rows() { return rows; },
		get elapsed() { return elapsed; },
		get dt() { return dt; },
		get frame() { return frame; },
		get fps() { return fpsEma; },
		get cellAspect() { return cellW > 0 ? cellH / cellW : 1; },
		mouse,
		keys: keysApi,

		set(x, y, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			if (x < 0 || y < 0 || x >= cols || y >= rows) return;
			const k = y * cols + x;
			chars[k] = char.charCodeAt(0);
			fgIdx[k] = colorIdx(fg);
			bgIdx[k] = colorIdx(bg);
			dirtyRows[y] = 1;
		},
		color(s) { return colorIdx(s); },
		setI(x, y, code, fIdx, bIdx) {
			if (x < 0 || y < 0 || x >= cols || y >= rows) return;
			const k = y * cols + x;
			chars[k] = code;
			fgIdx[k] = fIdx;
			bgIdx[k] = bIdx;
			dirtyRows[y] = 1;
		},
		blit(srcChars, srcFg, srcBg) {
			const size = cols * rows;
			if (srcChars.length !== size || srcFg.length !== size || srcBg.length !== size) return;
			chars.set(srcChars);
			fgIdx.set(srcFg);
			bgIdx.set(srcBg);
			dirtyRows.fill(1);
		},
		get(x, y) {
			if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
			const k = y * cols + x;
			cellView.char = String.fromCharCode(chars[k]);
			cellView.fg = paletteStr[fgIdx[k]];
			cellView.bg = paletteStr[bgIdx[k]];
			return cellView;
		},
		fill(char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			const code = char.charCodeAt(0);
			const f = colorIdx(fg);
			const b = colorIdx(bg);
			chars.fill(code);
			fgIdx.fill(f);
			bgIdx.fill(b);
			dirtyRows.fill(1);
		},
		clear() { this.fill(' ', DEFAULT_FG, DEFAULT_BG); },
		fillRect(x, y, w, h, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			const x0 = Math.max(0, x), y0 = Math.max(0, y);
			const x1 = Math.min(cols, x + w), y1 = Math.min(rows, y + h);
			if (x1 <= x0 || y1 <= y0) return;
			const code = char.charCodeAt(0);
			const f = colorIdx(fg);
			const b = colorIdx(bg);
			for (let j = y0; j < y1; j++) {
				const off = j * cols;
				for (let i = x0; i < x1; i++) {
					const k = off + i;
					chars[k] = code;
					fgIdx[k] = f;
					bgIdx[k] = b;
				}
				dirtyRows[j] = 1;
			}
		},
		strokeRect(x, y, w, h, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			for (let i = x; i < x + w; i++) { this.set(i, y, char, fg, bg); this.set(i, y + h - 1, char, fg, bg); }
			for (let j = y; j < y + h; j++) { this.set(x, j, char, fg, bg); this.set(x + w - 1, j, char, fg, bg); }
		},
		line(x0, y0, x1, y1, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
			let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
			let err = dx + dy;
			while (true) {
				this.set(x0, y0, char, fg, bg);
				if (x0 === x1 && y0 === y1) break;
				const e2 = 2 * err;
				if (e2 >= dy) { err += dy; x0 += sx; }
				if (e2 <= dx) { err += dx; y0 += sy; }
			}
		},
		circle(cx, cy, r, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			let x = r, y = 0, err = 1 - r;
			while (x >= y) {
				this.set(cx + x, cy + y, char, fg, bg);
				this.set(cx + y, cy + x, char, fg, bg);
				this.set(cx - y, cy + x, char, fg, bg);
				this.set(cx - x, cy + y, char, fg, bg);
				this.set(cx - x, cy - y, char, fg, bg);
				this.set(cx - y, cy - x, char, fg, bg);
				this.set(cx + y, cy - x, char, fg, bg);
				this.set(cx + x, cy - y, char, fg, bg);
				y++;
				if (err < 0) err += 2 * y + 1;
				else { x--; err += 2 * (y - x + 1); }
			}
		},
		fillCircle(cx, cy, r, char, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			if (r <= 0) return;
			const aspect = cellW > 0 ? cellH / cellW : 1;
			const rowSpan = r / aspect;
			const yMin = Math.max(0, Math.ceil(cy - rowSpan));
			const yMax = Math.min(rows - 1, Math.floor(cy + rowSpan));
			const code = char.charCodeAt(0);
			const f = colorIdx(fg);
			const b = colorIdx(bg);
			const r2 = r * r;
			for (let y = yMin; y <= yMax; y++) {
				const dy = (y - cy) * aspect;
				const dd = r2 - dy * dy;
				if (dd < 0) continue;
				const halfW = Math.sqrt(dd);
				const x0 = Math.max(0, Math.ceil(cx - halfW));
				const x1 = Math.min(cols - 1, Math.floor(cx + halfW));
				if (x1 < x0) continue;
				const off = y * cols;
				for (let x = x0; x <= x1; x++) {
					const k = off + x;
					chars[k] = code;
					fgIdx[k] = f;
					bgIdx[k] = b;
				}
				dirtyRows[y] = 1;
			}
		},
		border(x, y, w, h, style, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			if (w < 2 || h < 2) return;
			const s = BORDER_STYLES[style];
			const x1 = x + w - 1;
			const y1 = y + h - 1;
			this.set(x, y, s.tl, fg, bg);
			this.set(x1, y, s.tr, fg, bg);
			this.set(x, y1, s.bl, fg, bg);
			this.set(x1, y1, s.br, fg, bg);
			for (let i = x + 1; i < x1; i++) {
				this.set(i, y, s.h, fg, bg);
				this.set(i, y1, s.h, fg, bg);
			}
			for (let j = y + 1; j < y1; j++) {
				this.set(x, j, s.v, fg, bg);
				this.set(x1, j, s.v, fg, bg);
			}
		},
		text(x, y, str, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			for (let i = 0; i < str.length; i++) this.set(x + i, y, str[i], fg, bg);
		},
		textCentered(x, y, str, fg, bg) {
			this.text(x - (str.length >> 1), y, str, fg, bg);
		},
		textRight(x, y, str, fg, bg) {
			this.text(x - str.length + 1, y, str, fg, bg);
		},
		textBox(x, y, w, h, str, opts = {}) {
			const fg = opts.fg ?? DEFAULT_FG;
			const bg = opts.bg ?? DEFAULT_BG;
			const align = opts.align ?? 'left';
			const valign = opts.valign ?? 'top';
			const wrap = opts.wrap ?? 'word';
			const overflow = opts.overflow ?? 'clip';
			const ellipsis = opts.ellipsis ?? '…';
			const spacing = opts.lineSpacing ?? 0;

			let pt = 0, pr = 0, pb = 0, pl = 0;
			const p = opts.padding;
			if (typeof p === 'number') { pt = pr = pb = pl = p; }
			else if (p && 'x' in p) { pt = pb = p.y; pl = pr = p.x; }
			else if (p) { pt = p.top; pr = p.right; pb = p.bottom; pl = p.left; }

			if (opts.shadow) {
				const sb = colorIdx(opts.shadow);
				const sx0 = Math.max(0, x + 1);
				const sy0 = Math.max(0, y + 1);
				const sx1 = Math.min(cols, x + w + 1);
				const sy1 = Math.min(rows, y + h + 1);
				// L-shape: right column (x+w) from y+1..y+h, and bottom row (y+h) from x+1..x+w-1
				const rightX = x + w;
				if (rightX >= 0 && rightX < cols) {
					for (let j = sy0; j < sy1; j++) {
						const k = j * cols + rightX;
						bgIdx[k] = sb;
						dirtyRows[j] = 1;
					}
				}
				const botY = y + h;
				if (botY >= 0 && botY < rows) {
					const off = botY * cols;
					const bx1 = Math.min(cols, x + w);
					for (let i = sx0; i < bx1; i++) {
						bgIdx[off + i] = sb;
					}
					dirtyRows[botY] = 1;
				}
			}

			if (opts.clearBg !== false) {
				this.fillRect(x, y, w, h, ' ', fg, bg);
			}

			if (opts.border) {
				const style: BorderStyle = opts.border === true ? 'single' : opts.border;
				this.border(x, y, w, h, style, opts.borderFg ?? fg, opts.borderBg ?? bg);
				pt += 1; pr += 1; pb += 1; pl += 1;
			}

			const innerX = x + pl;
			const innerY = y + pt;
			const innerW = w - pl - pr;
			const innerH = h - pt - pb;
			if (innerW <= 0 || innerH <= 0) return;

			const lines: string[] = [];
			const paragraphs = str.split('\n');
			if (wrap === 'none') {
				for (const ln of paragraphs) lines.push(ln);
			} else if (wrap === 'char') {
				for (const ln of paragraphs) {
					if (ln.length === 0) { lines.push(''); continue; }
					for (let i = 0; i < ln.length; i += innerW) lines.push(ln.slice(i, i + innerW));
				}
			} else {
				for (const ln of paragraphs) {
					if (ln.length === 0) { lines.push(''); continue; }
					const words = ln.split(' ');
					let cur = '';
					for (const word of words) {
						if (word.length > innerW) {
							if (cur.length > 0) { lines.push(cur); cur = ''; }
							let i = 0;
							while (i < word.length) {
								const part = word.slice(i, i + innerW);
								if (i + innerW >= word.length) cur = part;
								else lines.push(part);
								i += innerW;
							}
						} else if (cur.length === 0) {
							cur = word;
						} else if (cur.length + 1 + word.length <= innerW) {
							cur += ' ' + word;
						} else {
							lines.push(cur);
							cur = word;
						}
					}
					lines.push(cur);
				}
			}

			let spaced = lines;
			if (spacing > 0) {
				spaced = [];
				for (let i = 0; i < lines.length; i++) {
					spaced.push(lines[i]);
					if (i < lines.length - 1) for (let s = 0; s < spacing; s++) spaced.push('');
				}
			}

			let display: string[] = spaced;
			if (spaced.length > innerH) {
				display = spaced.slice(0, innerH);
				if (overflow === 'ellipsis' && innerH > 0) {
					const last = display[innerH - 1];
					const clipLen = Math.max(0, innerW - ellipsis.length);
					display[innerH - 1] = last.slice(0, clipLen) + ellipsis;
				}
			}
			for (let i = 0; i < display.length; i++) {
				if (display[i].length > innerW) {
					if (overflow === 'ellipsis')
						display[i] = display[i].slice(0, Math.max(0, innerW - ellipsis.length)) + ellipsis;
					else display[i] = display[i].slice(0, innerW);
				}
			}

			let yStart = innerY;
			if (valign === 'middle') yStart = innerY + ((innerH - display.length) >> 1);
			else if (valign === 'bottom') yStart = innerY + (innerH - display.length);

			for (let i = 0; i < display.length; i++) {
				const line = display[i];
				let xStart = innerX;
				if (align === 'center') xStart = innerX + ((innerW - line.length) >> 1);
				else if (align === 'right') xStart = innerX + (innerW - line.length);
				this.text(xStart, yStart + i, line, fg, bg);
			}
		},
		debugBox(x, y, stats, opts = {}) {
			const precision = opts.precision ?? 2;
			const fg = opts.fg ?? DEFAULT_FG;
			const bg = opts.bg ?? DEFAULT_BG;
			const keyFg = opts.keyFg ?? fg;
			const valFg = opts.valFg ?? fg;
			const border = opts.border ?? 'single';
			const padding = opts.padding ?? { x: 1, y: 0 };

			const fmt = (v: unknown): string => {
				if (typeof v === 'number') {
					if (!Number.isFinite(v)) return String(v);
					if (Number.isInteger(v)) return String(v);
					return v.toFixed(precision);
				}
				if (typeof v === 'boolean') return v ? 'true' : 'false';
				if (v === null) return 'null';
				if (v === undefined) return 'undef';
				if (typeof v === 'object') {
					try { return JSON.stringify(v); } catch { return String(v); }
				}
				return String(v);
			};

			const entries = Object.entries(stats);
			const keys = entries.map(([k]) => k + ':');
			const rawVals = entries.map(([, v]) => fmt(v));
			// Align values by decimal point: integer parts right-aligned, fractional
			// parts left-aligned. For non-decimal values, the whole string is the
			// "integer part" so they right-align with the others.
			const valParts = rawVals.map((v) => {
				const dot = v.indexOf('.');
				return dot >= 0 ? [v.slice(0, dot), v.slice(dot)] : [v, ''];
			});
			const maxInt = valParts.reduce((m, [i]) => Math.max(m, i.length), 0);
			const maxFrac = valParts.reduce((m, [, f]) => Math.max(m, f.length), 0);
			const vals = valParts.map(
				([i, f]) => i.padStart(maxInt, ' ') + f.padEnd(maxFrac, ' ')
			);
			const keyW = keys.reduce((m, k) => Math.max(m, k.length), 0);
			const valW = maxInt + maxFrac;
			const gap = keyW > 0 && valW > 0 ? 1 : 0;
			let innerW = keyW + gap + valW;
			if (opts.title) innerW = Math.max(innerW, opts.title.length);
			const titleH = opts.title ? 2 : 0;
			let innerH = entries.length + titleH;

			let pt = 0, pr = 0, pb = 0, pl = 0;
			if (typeof padding === 'number') { pt = pr = pb = pl = padding; }
			else if ('x' in padding) { pt = pb = padding.y; pl = pr = padding.x; }
			else { pt = padding.top; pr = padding.right; pb = padding.bottom; pl = padding.left; }
			const borderPad = border ? 2 : 0;
			const w = opts.w ?? (innerW + pl + pr + borderPad);
			const h = opts.h ?? (innerH + pt + pb + borderPad);

			this.textBox(x, y, w, h, '', {
				border,
				borderFg: opts.borderFg ?? fg,
				borderBg: opts.borderBg ?? bg,
				padding,
				fg,
				bg,
				shadow: opts.shadow,
				clearBg: opts.clearBg,
				wrap: 'none'
			});

			const innerX = x + pl + (border ? 1 : 0);
			const innerY = y + pt + (border ? 1 : 0);
			const availW = w - pl - pr - borderPad;
			const availH = h - pt - pb - borderPad;
			if (availW <= 0 || availH <= 0) return;

			let row = 0;
			if (opts.title && row < availH) {
				const t = opts.title.length > availW ? opts.title.slice(0, availW) : opts.title;
				this.text(innerX, innerY + row, t, fg, bg);
				row++;
				if (row < availH) {
					const sepLen = Math.min(availW, innerW);
					if (sepLen > 0) this.text(innerX, innerY + row, '─'.repeat(sepLen), fg, bg);
					row++;
				}
			}
			for (let i = 0; i < entries.length && row < availH; i++, row++) {
				const k = keys[i];
				const v = vals[i];
				const kClipped = k.length > availW ? k.slice(0, availW) : k;
				this.text(innerX, innerY + row, kClipped, keyFg, bg);
				const valRoom = availW - kClipped.length - 1;
				if (valRoom > 0 && v.length > 0) {
					const vClipped = v.length > valRoom ? v.slice(0, valRoom) : v;
					const vx = innerX + availW - vClipped.length;
					this.text(vx, innerY + row, vClipped, valFg, bg);
				}
			}
		},
		forEach(fn) {
			const view = cellView;
			for (let j = 0; j < rows; j++) {
				const off = j * cols;
				for (let i = 0; i < cols; i++) {
					const k = off + i;
					view.char = String.fromCharCode(chars[k]);
					view.fg = paletteStr[fgIdx[k]];
					view.bg = paletteStr[bgIdx[k]];
					fn(i, j, view, k);
				}
			}
		},
		forRect(x, y, w, h, fn) {
			const x0 = Math.max(0, x), y0 = Math.max(0, y);
			const x1 = Math.min(cols, x + w), y1 = Math.min(rows, y + h);
			for (let j = y0; j < y1; j++)
				for (let i = x0; i < x1; i++) fn(i, j);
		},
		ramp(t, chars_ = DEFAULT_RAMP) { return rampChar(t, chars_); },
		field(fn, ramp = DEFAULT_RAMP, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			doField(0, 0, cols, rows, fn, ramp, fg, bg);
		},
		fieldRect(x, y, w, h, fn, ramp = DEFAULT_RAMP, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			const x0 = Math.max(0, x), y0 = Math.max(0, y);
			const x1 = Math.min(cols, x + w), y1 = Math.min(rows, y + h);
			if (x1 <= x0 || y1 <= y0) return;
			doField(x0, y0, x1, y1, fn, ramp, fg, bg);
		},
		fieldArr(values, ramp = DEFAULT_RAMP, fg = DEFAULT_FG, bg = DEFAULT_BG) {
			const size = cols * rows;
			if (values.length !== size) return;
			const codes = rampCodes(ramp);
			const rampLen = codes.length;
			const rampMaxI = rampLen - 1;
			const f = colorIdx(fg);
			const b = colorIdx(bg);
			for (let i = 0; i < size; i++) {
				let t = values[i];
				if (t < 0) t = 0;
				else if (t > 1) t = 1;
				const qi = t === 1 ? rampMaxI : (t * rampLen) | 0;
				chars[i] = codes[qi];
				fgIdx[i] = f;
				bgIdx[i] = b;
			}
			dirtyRows.fill(1);
		},
		contour(fn, levels, charFor) {
			const ls = typeof levels === 'number' ? [levels] : levels;
			const map = charFor ?? ((case_: number) => MS_DEFAULT_CHARS[case_]);
			for (let li = 0; li < ls.length; li++) {
				const lvl = ls[li];
				for (let y = 0; y < rows - 1; y++) {
					for (let x = 0; x < cols - 1; x++) {
						const a = fn(x, y) >= lvl ? 1 : 0;
						const b = fn(x + 1, y) >= lvl ? 1 : 0;
						const c = fn(x + 1, y + 1) >= lvl ? 1 : 0;
						const d = fn(x, y + 1) >= lvl ? 1 : 0;
						const idx = a | (b << 1) | (c << 2) | (d << 3);
						if (idx === 0 || idx === 15) continue;
						const ch = map(idx, lvl);
						if (ch) this.set(x, y, ch);
					}
				}
			}
		},
		dither(fn, opts: DitherOpts = {}) {
			const type = opts.type ?? 'floyd-steinberg';
			const ramp = opts.ramp ?? DEFAULT_RAMP;
			const rampLen = ramp.length;
			const fg = opts.fg ?? DEFAULT_FG;
			const bg = opts.bg ?? DEFAULT_BG;
			const levels = Math.max(2, opts.levels ?? rampLen);
			const r = opts.rect ?? { x: 0, y: 0, w: cols, h: rows };
			const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
			const x1 = Math.min(cols, r.x + r.w), y1 = Math.min(rows, r.y + r.h);
			if (x1 <= x0 || y1 <= y0) return;

			const codes = rampCodes(ramp);
			const f = colorIdx(fg);
			const b = colorIdx(bg);
			const writeCell = (x: number, y: number, qi: number) => {
				const k = y * cols + x;
				chars[k] = codes[qi];
				fgIdx[k] = f;
				bgIdx[k] = b;
			};

			if (type === 'threshold') {
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						let t = fn(x, y);
						if (t < 0) t = 0; else if (t > 1) t = 1;
						const lvl = Math.min(levels - 1, (t * levels) | 0);
						const qi = Math.min(rampLen - 1, Math.round(lvl * (rampLen - 1) / (levels - 1)));
						writeCell(x, y, qi);
					}
					dirtyRows[y] = 1;
				}
			} else if (type === 'ordered') {
				const size = opts.bayerSize ?? 4;
				const m = size === 2 ? BAYER_2 : size === 8 ? BAYER_8 : BAYER_4;
				const norm = size * size;
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						let t = fn(x, y);
						if (t < 0) t = 0; else if (t > 1) t = 1;
						const thr = (m[y % size][x % size] + 0.5) / norm;
						const adj = t + (thr - 0.5) / levels;
						const qi = Math.max(0, Math.min(rampLen - 1, (adj * rampLen) | 0));
						writeCell(x, y, qi);
					}
					dirtyRows[y] = 1;
				}
			} else {
				const w = x1 - x0, h = y1 - y0;
				const buf = new Float32Array(w * h);
				for (let j = 0; j < h; j++) {
					for (let i = 0; i < w; i++) {
						let t = fn(x0 + i, y0 + j);
						if (t < 0) t = 0; else if (t > 1) t = 1;
						buf[j * w + i] = t;
					}
				}
				const serp = opts.serpentine ?? true;
				const maxQi = rampLen - 1;
				for (let j = 0; j < h; j++) {
					const ltr = !serp || (j & 1) === 0;
					const iStart = ltr ? 0 : w - 1;
					const iEnd = ltr ? w : -1;
					const step = ltr ? 1 : -1;
					for (let i = iStart; i !== iEnd; i += step) {
						const k = j * w + i;
						const old = buf[k];
						const qi = Math.max(0, Math.min(maxQi, Math.round(old * maxQi)));
						const quant = qi / maxQi;
						const err = old - quant;
						writeCell(x0 + i, y0 + j, qi);
						const right = i + step;
						if (right >= 0 && right < w) buf[j * w + right] += err * 7 / 16;
						if (j + 1 < h) {
							const down = j + 1;
							if (i - step >= 0 && i - step < w) buf[down * w + (i - step)] += err * 3 / 16;
							buf[down * w + i] += err * 5 / 16;
							if (right >= 0 && right < w) buf[down * w + right] += err * 1 / 16;
						}
					}
					dirtyRows[y0 + j] = 1;
				}
			}
		},
		bset(px, py, fg = DEFAULT_FG) {
			const cx = px >> 1;
			const cy = py >> 2;
			if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
			const k = cy * cols + cx;
			const existing = chars[k];
			let mask = 0;
			if (existing >= BRAILLE_BASE && existing <= BRAILLE_BASE + 0xFF) {
				mask = existing - BRAILLE_BASE;
			}
			const bit = BRAILLE_BITS[(py & 3) * 2 + (px & 1)];
			mask |= bit;
			chars[k] = BRAILLE_BASE + mask;
			fgIdx[k] = colorIdx(fg);
			dirtyRows[cy] = 1;
		},
		bline(x0, y0, x1, y1, fg = DEFAULT_FG) {
			let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
			let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
			let err = dx + dy;
			while (true) {
				this.bset(x0, y0, fg);
				if (x0 === x1 && y0 === y1) break;
				const e2 = 2 * err;
				if (e2 >= dy) { err += dy; x0 += sx; }
				if (e2 <= dx) { err += dx; y0 += sy; }
			}
		},
		bcircle(cx, cy, r, fg = DEFAULT_FG) {
			let x = r, y = 0, err = 1 - r;
			while (x >= y) {
				this.bset(cx + x, cy + y, fg);
				this.bset(cx + y, cy + x, fg);
				this.bset(cx - y, cy + x, fg);
				this.bset(cx - x, cy + y, fg);
				this.bset(cx - x, cy - y, fg);
				this.bset(cx - y, cy - x, fg);
				this.bset(cx + y, cy - x, fg);
				this.bset(cx + x, cy - y, fg);
				y++;
				if (err < 0) err += 2 * y + 1;
				else { x--; err += 2 * (y - x + 1); }
			}
		},
		bclear() {
			for (let j = 0; j < rows; j++) {
				const off = j * cols;
				let rowDirty = false;
				for (let i = 0; i < cols; i++) {
					const k = off + i;
					const c = chars[k];
					if (c >= BRAILLE_BASE && c <= BRAILLE_BASE + 0xFF) {
						chars[k] = CH_SPACE;
						fgIdx[k] = DEF_FG_IDX;
						bgIdx[k] = DEF_BG_IDX;
						rowDirty = true;
					}
				}
				if (rowDirty) dirtyRows[j] = 1;
			}
		},
		rgb, hsl, rgbQ, hslQ, lerpColor,
		profile
	};

	if (PROFILE && typeof globalThis !== 'undefined') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(globalThis as any).__asciiProfile = profile;
	}

	function tick(t: number) {
		if (document.hidden) {
			lastT = 0;
			rafId = requestAnimationFrame(tick);
			return;
		}
		if (!lastT) lastT = t;
		dt = (t - lastT) / 1000;
		elapsed += dt;
		lastT = t;

		if (dt > 0) {
			const fps = 1 / dt;
			fpsEma = fpsEma === 0 ? fps : fpsEma * 0.9 + fps * 0.1;
		}

		const tFrameStart = performance.now();
		effect(api);
		const tEffectEnd = PROFILE ? performance.now() : 0;
		renderToDOM();
		const tEffectDone = performance.now();

		if (PROFILE) {
			profileFrames.push({
				frame,
				effectMs: tEffectEnd - tFrameStart,
				renderMs: tEffectDone - tEffectEnd,
				totalMs: tEffectDone - tFrameStart,
				textPathCount: pTextCount,
				textPathMs: pTextMs,
				uniformPathCount: pUniformCount,
				uniformPathMs: pUniformMs,
				htmlPathCount: pHtmlCount,
				htmlPathMs: pHtmlMs,
				paletteSize: paletteStr.length,
				dirtyRowsRendered: pDirtyRowsRendered,
				cols,
				rows
			});
			// Cap so a long-running tab can't OOM the array. Harness samples
			// frequently enough that 4096 frames (≈68s @60fps) is plenty.
			if (profileFrames.length > 4096) profileFrames.shift();
			pTextCount = 0; pTextMs = 0;
			pUniformCount = 0; pUniformMs = 0;
			pHtmlCount = 0; pHtmlMs = 0;
			pDirtyRowsRendered = 0;
		}

		if (!firstFrameLogged) {
			firstFrameLogged = true;
			requestAnimationFrame(() => {
				const tPainted = performance.now();
				const grid = `${cols}×${rows} (${cols * rows} cells)`;
				// eslint-disable-next-line no-console
				console.log(
					'[ascii] first-frame timing — ' + grid + '\n' +
					'  mount → resize done:      ' + (tResizeDone - tMount).toFixed(2) + ' ms\n' +
					'  resize → first tick:      ' + (tFrameStart - tResizeDone).toFixed(2) + ' ms  (rAF latency)\n' +
					'  effect + swap (DOM write):' + (tEffectDone - tFrameStart).toFixed(2) + ' ms\n' +
					'  DOM write → browser paint:' + (tPainted - tEffectDone).toFixed(2) + ' ms\n' +
					'  total mount → paint:      ' + (tPainted - tMount).toFixed(2) + ' ms'
				);
			});
		}

		frame++;
		if (keysPressedThisFrame.size > 0) keysPressedThisFrame.clear();
		rafId = requestAnimationFrame(tick);
	}

	function onMouseMove(e: MouseEvent) {
		mouse.px = mouse.x;
		mouse.py = mouse.y;
		mouse.fx = (e.clientX - preRect.left) / cellW;
		mouse.fy = (e.clientY - preRect.top) / cellH;
		mouse.x = Math.floor(mouse.fx);
		mouse.y = Math.floor(mouse.fy);
	}

	// ─── Initial layout + frame ────────────────────────────────────────
	resize();
	tResizeDone = performance.now();

	// rAF-coalesced resize — at most one relayout per frame during drag.
	let resizePending = false;
	const ro = new ResizeObserver(() => {
		if (resizePending) return;
		resizePending = true;
		requestAnimationFrame(() => {
			resizePending = false;
			resize();
		});
	});
	ro.observe(wrapEl);

	const updateRect = () => {
		const pr = preEl.getBoundingClientRect();
		preRect.left = pr.left;
		preRect.top = pr.top;
	};
	window.addEventListener('scroll', updateRect, { passive: true });
	window.addEventListener('resize', updateRect);

	preEl.addEventListener('mousemove', onMouseMove);

	function setMouseFromClient(clientX: number, clientY: number, snapPrev: boolean) {
		const fx = (clientX - preRect.left) / cellW;
		const fy = (clientY - preRect.top) / cellH;
		const x = Math.floor(fx);
		const y = Math.floor(fy);
		if (snapPrev) {
			mouse.px = x;
			mouse.py = y;
		} else {
			mouse.px = mouse.x;
			mouse.py = mouse.y;
		}
		mouse.fx = fx;
		mouse.fy = fy;
		mouse.x = x;
		mouse.y = y;
	}
	function onTouchStart(e: TouchEvent) {
		if (e.touches.length === 0) return;
		e.preventDefault();
		const t = e.touches[0];
		setMouseFromClient(t.clientX, t.clientY, true);
	}
	function onTouchMove(e: TouchEvent) {
		if (e.touches.length === 0) return;
		e.preventDefault();
		const t = e.touches[0];
		setMouseFromClient(t.clientX, t.clientY, false);
	}
	if (enableTouch) {
		preEl.style.touchAction = 'none';
		preEl.addEventListener('touchstart', onTouchStart, { passive: false });
		preEl.addEventListener('touchmove', onTouchMove, { passive: false });
	}

	const onKeyDown = (e: KeyboardEvent) => {
		if (!keysDown.has(e.key)) keysPressedThisFrame.add(e.key);
		keysDown.add(e.key);
	};
	const onKeyUp = (e: KeyboardEvent) => { keysDown.delete(e.key); };
	const onBlur = () => { keysDown.clear(); keysPressedThisFrame.clear(); };
	window.addEventListener('keydown', onKeyDown);
	window.addEventListener('keyup', onKeyUp);
	window.addEventListener('blur', onBlur);

	rafId = requestAnimationFrame(tick);

	return {
		api,
		destroy() {
			cancelAnimationFrame(rafId);
			ro.disconnect();
			preEl.removeEventListener('mousemove', onMouseMove);
			if (enableTouch) {
				preEl.removeEventListener('touchstart', onTouchStart);
				preEl.removeEventListener('touchmove', onTouchMove);
			}
			window.removeEventListener('scroll', updateRect);
			window.removeEventListener('resize', updateRect);
			window.removeEventListener('keydown', onKeyDown);
			window.removeEventListener('keyup', onKeyUp);
			window.removeEventListener('blur', onBlur);
		}
	};
}
