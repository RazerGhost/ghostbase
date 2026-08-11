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

	// /newtab stands in for the browser's own new-tab page, so site chrome
	// (nav, footer, Ctrl+K palette) doesn't belong there.
	const isFullBleed = $derived(page.url.pathname === '/newtab');
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
