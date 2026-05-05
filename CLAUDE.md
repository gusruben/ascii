# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **bun** (`engine-strict=true` in `.npmrc`).

- `bun install` — install deps
- `bun run dev` — Vite dev server (SvelteKit)
- `bun run build` — production build
- `bun run preview` — serve the production build
- `bun run check` — `svelte-kit sync && svelte-check`. Runs `svelte-kit sync` first, so a fresh clone needs it before `check` can pass.
- `bun run check:watch` — same, watch mode
- `bun run test` / `test:watch` — Vitest suite in `src/lib/ascii/*.test.ts` (happy-dom). Takes file/pattern args.

`svelte-check` takes no file argument. Narrow scope by editing only what you're working on and re-running.

## Testing

Tests live next to source in `src/lib/ascii/`. `testHelpers.makeHarness(cols, rows)` stubs `getBoundingClientRect` and `requestAnimationFrame` so tests drive frames with `h.frame(effect)`.

- `colors.test.ts` — pure color helpers.
- `runtime.test.ts` — row-path selection, mode transitions, dirty-row short-circuit.
- `dirtyBits.test.ts` — one test per mutator asserting exactly which rows' DOM changed. **New mutators on `AsciiApi` require a corresponding test here** — otherwise a missing `dirtyRows[y] = 1` silently hides writes.

## Architecture

SvelteKit app (Svelte 5 runes mode, Tailwind v4). The codebase is split into a reusable ASCII runtime library under `src/lib/ascii/` and thin route pages under `src/routes/*` that each provide one visual effect.

### Adding a new effect page

A new effect is ~15 lines: create `src/routes/<name>/+page.svelte`, import `AsciiCanvas`, write an `effect(c: AsciiApi)` function that draws one frame, and render `<AsciiCanvas {effect} />`. See `src/routes/circles/+page.svelte` for the minimal example. Effects are called once per animation frame; the runtime commits the buffer to the DOM automatically afterward.

### `src/lib/ascii/` — the renderer

- **`AsciiCanvas.svelte`** — component that renders the wrap+`<pre>`, calls `createAsciiRuntime` on mount, returns the cleanup from `onMount`.
- **`runtime.ts`** — `createAsciiRuntime(wrapEl, preEl, effect)` owns all renderer state in a closure (plain `let`, not runes — see below). Returns `{ api, destroy }`. Handles buffers, palette, the RAF loop, ResizeObserver, keyboard, and mouse.
- **`types.ts`** — `AsciiApi`, `Cell`, `Effect`, option types. The public `AsciiApi` surface is what effects call.
- **`constants.ts`** — font, default colors, `DEFAULT_RAMP`, `BORDER_STYLES`, Braille (`BRAILLE_BASE`/`BRAILLE_BITS`), Bayer matrices, `MS_DEFAULT_CHARS`, char-code constants.
- **`colors.ts`** — `rgb`, `hsl`, `lerpColor`, `rampCodes`, `rampChar`. All color builders return stable `#rrggbb` strings so the palette stays bounded under animated color math.
- **`index.ts`** — re-exports `AsciiCanvas`, `createAsciiRuntime`, and types.

### Renderer internals (non-obvious, perf-critical)

The renderer is DOM-based, not Canvas: a `<pre>` with one `<span>` child per row (each `display:block; content-visibility:auto`; parent `<pre>` has `contain: strict`). The structure is deliberately shaped for throughput — do not "simplify" toward AoS `Cell[]` or naive `innerHTML` everywhere.

**Svelte 5 runes are forced globally** (`svelte.config.js`). Plain `let` at module scope in `.ts` files is non-reactive normal TS. The runtime closure in `runtime.ts` relies on this to hold perf-critical state without reactivity overhead. Don't convert those `let` declarations to `$state` — it would regress performance.

**Cell storage is Struct-of-Arrays, not Array-of-Structs.** Six parallel `Uint16Array`s: `chars`, `fgIdx`, `bgIdx`, and back-buffers. Characters are single UTF-16 code units (BMP-only — surrogate pairs silently break). Colors are palette indices, not strings.

**Colors intern through a lazy palette.** `paletteMap: Map<string, number>` / `paletteStr: string[]` with `DEFAULT_FG` at index 0 and `DEFAULT_BG` at index 1. `colorIdx(s)` registers new colors on first use. Cell diff is three `Uint16 === Uint16` compares, not string compares. Don't pass unbounded varying color strings (e.g. `hsl(..., ${continuously-changing-t})`) without quantizing first, or the palette grows forever.

**Per-row DOM update takes one of three paths** (chosen in `renderToDOM`'s diff pass):

1. *Text / fast path* — all cells are default fg/bg. Writes `rowText[j].data = s` on a **cached** `Text` node. Skipping `textContent = s` avoids reallocating the node every frame.
2. *Uniform / non-default-but-single-color path* — every cell in the row shares one `(fg,bg)`. Sets `rowEl.style.color` / `style.background` once (tracked via `rowCurFg[j]` / `rowCurBg[j]` so redundant writes are skipped) and reuses the same text-node write.
3. *Mixed / slow path* — styles vary across the row. Builds `<span style="…">` runs with coalescing and sets `rowEl.innerHTML`. Escapes `<`, `>`, `&` here only.

`rowMode[j]` (0 = text/uniform, 1 = html) tracks which path last rendered each row so the next render can tear down whatever was there.

**Dirty-row bitmap** (`dirtyRows: Uint8Array`) is maintained by the API mutators (`set`, `fill`, `fillRect`, `strokeRect`, `line`, `circle`, `text`, etc.) rather than scanned. The render loop short-circuits on `!dirtyRows[j]`. New API methods that write to the buffer **must** flip the corresponding row bits or their writes won't render.

**Resize avoids flicker via two cooperating tricks:**

1. Existing rows' `Text` nodes are preserved across `resize()` — stale content stays visible until the new content overwrites it.
2. After reallocating, `resize()` synchronously calls `effect(api)` and `renderToDOM()` one extra time so the paint that follows resize-rAF already contains new-size content. Back-buffers are filled with sentinel `0xFFFF` so this eager render treats every cell as dirty.

Both depend on each other; removing either reintroduces a blank/stale frame.

### Effect authoring caveats

- Effects receive `c: AsciiApi` and should draw one frame. The runtime calls `renderToDOM()` automatically after the effect returns — there is no `swap()` to call.
- `api.get(x, y)` and `api.forEach` return a **shared scratch `Cell`** for zero allocation. Callers must not retain the reference or mutate it expecting a write-back — use `api.set` to write.
- `api.cellAspect` = `cellH / cellW` (≈ 2 for monospace fonts). Effects that want visually-round circles should scale y-deltas by this value, since cells are typically twice as tall as wide.
- `api.fps` is EMA-smoothed and updated in `tick`; effects can render it themselves.
- `api.mouse` exposes both integer cell coords (`x`, `y`, plus previous-frame `px`, `py`) and fractional coords (`fx`, `fy`). Use `fx`/`fy` when drawing at sub-cell resolution (e.g. half-block tiles, Braille) so you can tell which sub-cell the cursor is in.
- A one-time first-frame timing breakdown (mount → resize → first tick → effect+render → browser paint) is logged to the console on load.
- **Do not add or change colors unless the user asks for them.** Default fg/bg is the fastest path (see perf note below); adding colors unprompted pushes effects onto slower paths and changes the look the user was happy with.

### Performance: the three render paths and the cliff between them

Per-row render paths (see `renderToDOM` in `runtime.ts`), in descending speed:

1. **Text path** — every cell in the row is default fg/bg. One `textNode.data = s` write per dirty row. Fastest.
2. **Uniform path** — every cell in the row shares a single non-default `(fg, bg)`. One style write + one text-node write per row. Nearly as fast as text.
3. **Mixed/HTML path** — styles vary within the row. `rowEl.innerHTML` is rebuilt from a string of coalesced `<span style="…">` runs. **~10–50× slower than paths 1/2** at full-screen sizes.

The cliff is invisible from the effect API — `c.set(x, y, ch, fg, bg)` in a loop with per-cell-varying color silently forces the slow path for every row. At 200×60 that's ~60 `innerHTML` rebuilds per frame, which will tank a simulation.

Rules of thumb for effects that touch most of the screen:
- Prefer `c.field(fn, ramp, fg, bg)` with a single fg/bg — hits the uniform path.
- If you need color variety, try to make it row-uniform (same fg/bg across each row) rather than per-cell. Varying colors vertically is free; varying horizontally forces the HTML path.
- Per-cell colors are fine for sparse overlays (a few hundred cells) on top of a uniform base.
- Quantize animated colors through `colorIdx` (pass the same `#rrggbb` string each frame) so the palette stays bounded.

For hot inner loops, bypass `c.set`'s per-call `Map.get × 2` via `c.color(s)` + `c.setI(x, y, code, fIdx, bIdx)`, or write a whole buffer with `c.blit(chars, fg, bg)`. When your data already lives in a typed array, `c.fieldArr(values, ramp, fg, bg)` skips the per-cell closure call that `c.field` incurs.

For animated color math in per-frame loops, prefer `c.hslQ(h, s, l, bins?)` / `c.rgbQ(r, g, b, bins?)` over `hsl`/`rgb`. They round inputs to a fixed number of steps (default 16) so the palette `Map` stays bounded under continuously-varying inputs. `hsl`/`rgb` with unquantized animated inputs will grow the palette indefinitely. Note: `hsl` takes `s`/`l` in **0..1**, not 0..100 — passing CSS-shaped values clamps to 1 and produces white; the runtime logs a one-time dev warning if it detects this.
