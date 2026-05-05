<script lang="ts">
	import { onMount } from 'svelte';
	import { createAsciiRuntime } from './runtime';
	import { DEFAULT_FG, FONT_FAMILY, FONT_SIZE_PX } from './constants';
	import type { Effect } from './types';

	let {
		effect,
		selectable = true,
		touch = true
	}: { effect: Effect; selectable?: boolean; touch?: boolean } = $props();

	let wrapEl: HTMLDivElement;
	let preEl: HTMLPreElement;

	onMount(() => {
		const runtime = createAsciiRuntime(wrapEl, preEl, effect, { touch });
		return runtime.destroy;
	});
</script>

<div bind:this={wrapEl} class="fixed inset-0 bg-gray-900 grid place-items-center overflow-hidden">
	<pre
		bind:this={preEl}
		class="bg-black m-0 overflow-hidden"
		style="color: {DEFAULT_FG}; font-family: {FONT_FAMILY}; font-size: {FONT_SIZE_PX}px; white-space: pre; user-select: {selectable ? 'text' : 'none'}; text-rendering: optimizeSpeed; font-variant-ligatures: none; contain: strict; will-change: contents;"
	></pre>
</div>
