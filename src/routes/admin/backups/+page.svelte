<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let running = $state(false);

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<Seo title="Backups — RazerGhost" description="Private backup status." path="/admin/backups" noindex />

<main class="mx-auto max-w-2xl px-6 py-16">
	<h1 class="text-3xl font-extrabold tracking-tight text-white">Backups</h1>
	<p class="mt-2 text-sm text-dim">
		Dumps <code>simkl-cache.db</code>, <code>spotify-history.db</code>, and
		<code>status.db</code> (plus the media library) to a private git repo.
	</p>

	{#if !data.configured}
		<p class="mt-6 text-sm text-red-400">
			<code>BACKUP_GIT_REMOTE</code> isn't set, so backups aren't configured yet.
		</p>
	{:else}
		<div class="mt-6 rounded-lg border border-border p-4 text-sm">
			<div class="text-xs text-dim">Last backup</div>
			{#if data.last}
				<div class="mt-0.5 font-medium text-white">{formatDate(data.last.timestamp)}</div>
				{#if data.last.message}<div class="mt-1 text-xs text-dim">{data.last.message}</div>{/if}
			{:else}
				<div class="mt-0.5 font-medium text-white">Never (or remote unreachable)</div>
			{/if}
		</div>

		<form
			method="POST"
			class="mt-6"
			use:enhance={() => {
				running = true;
				return async ({ update }) => {
					await update();
					running = false;
				};
			}}
		>
			<button
				type="submit"
				disabled={running}
				class="link rounded-full border border-primary px-4 py-2 text-sm text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{running ? 'Running…' : 'Run backup now'}
			</button>
		</form>

		{#if form && 'error' in form && form.error}
			<p class="mt-4 text-sm text-red-400">{form.error}</p>
		{/if}
		{#if form && 'result' in form && form.result}
			{#if form.result.committed}
				<p class="mt-4 text-sm text-primary">
					Backed up {form.result.dbs.join(', ') || 'nothing new'} at {formatDate(form.result.timestamp)}.
				</p>
			{:else}
				<p class="mt-4 text-sm text-dim">{form.result.message}</p>
			{/if}
		{/if}
	{/if}
</main>
