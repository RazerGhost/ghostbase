<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import BackToTop from '$lib/components/BackToTop.svelte';
	import SpotifyWidget from '$lib/components/SpotifyWidget.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// /notes is a full-bleed app view — its fixed-viewport canvas and own
	// Ctrl+K palette don't coexist with the site chrome (pushed page height
	// past 100vh, palette conflicts). /newtab stands in for the browser's
	// own new-tab page, so chrome doesn't belong there either.
	const isFullBleed = $derived(page.url.pathname === '/notes' || page.url.pathname === '/newtab');
</script>

{#if isFullBleed}
	<div class="h-screen bg-bg text-white">
		{@render children()}
	</div>
{:else}
	<div class="relative flex min-h-screen flex-col bg-bg text-white">
		<div class="bg-glow" aria-hidden="true"></div>
		<Nav />
		<div class="relative flex-1">
			{@render children()}
		</div>
		<Footer />
		<BackToTop />
		<SpotifyWidget />
		<CommandPalette entries={data.commandPaletteEntries} />
	</div>
{/if}
