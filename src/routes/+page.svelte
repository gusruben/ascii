<script lang="ts">
	const demos = [
		{ slug: 'circles', label: 'circles' },
		{ slug: 'donut', label: 'donut' },
		{ slug: 'radial', label: 'radial' },
		{ slug: 'life', label: 'life' },
		{ slug: 'hexagon', label: 'hexagon' },
		{ slug: '256col', label: '256col' },
		{ slug: 'window-movement', label: 'window-movement' },
		{ slug: 'water', label: 'water' },
		{ slug: 'mandelbrot', label: 'mandelbrot' },
		{ slug: 'panes', label: 'panes' },
		{ slug: 'draw', label: 'draw' },
		{ slug: 'ink', label: 'ink' }
	];
</script>

<svelte:head>
	<title>ascii</title>
</svelte:head>

<main class="min-h-screen bg-white p-4 font-mono text-black">
	<div class="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
		{#each demos as demo}
			<div>
				<div class="px-1 py-1 text-xs">
					<a href={`/${demo.slug}`} class="text-black underline hover:uppercase">
						{demo.label}
					</a>
				</div>
				<div class="relative h-60 overflow-hidden bg-slate-800">
					<iframe
						src={`/${demo.slug}`}
						title={demo.label}
						loading="lazy"
						class="h-full w-full border-0"
					></iframe>
				</div>
			</div>
		{/each}
	</div>
</main>
