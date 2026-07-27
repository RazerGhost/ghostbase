<script lang="ts">
	import { useLanyard, type LanyardData } from '$lib/stores/lanyard.svelte';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Globe from '@lucide/svelte/icons/globe';

	let { compact = false, activityOnly = false }: { compact?: boolean; activityOnly?: boolean } = $props();

	const lanyard = useLanyard();
	let now = $state(Date.now());

	const status = $derived(lanyard.status);
	const data = $derived(lanyard.data);

	const statusColor: Record<LanyardData['discord_status'], string> = {
		online: 'bg-primary',
		idle: 'bg-warn',
		dnd: 'bg-danger',
		offline: 'bg-dim'
	};

	const statusLabel: Record<LanyardData['discord_status'], string> = {
		online: 'Online',
		idle: 'Idle',
		dnd: 'Do not disturb',
		offline: 'Offline'
	};

	$effect(() => {
		lanyard.start();
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => {
			lanyard.stop();
			clearInterval(tick);
		};
	});

	// type 4 = custom status text, kept separate from the "headline" activity.
	// Spotify (type 2) is skipped for the headline too — it's already shown by
	// the site's own SpotifyWidget, so surfacing it again here is redundant.
	const customStatus = $derived(data?.activities.find((a) => a.type === 4));
	const activity = $derived(data?.activities.find((a) => a.type !== 4 && a.name !== 'Spotify'));

	function assetUrl(image: string | undefined, applicationId: string | undefined): string | null {
		if (!image) return null;
		if (image.startsWith('mp:')) return `https://media.discordapp.net/${image.slice(3)}`;
		if (image.startsWith('spotify:')) return `https://i.scdn.co/image/${image.slice('spotify:'.length)}`;
		if (!applicationId) return null;
		return `https://cdn.discordapp.com/app-assets/${applicationId}/${image}.png`;
	}

	const activityImage = $derived(
		activity ? assetUrl(activity.assets?.large_image, activity.application_id) : null
	);

	const avatarUrl = $derived(
		data?.discord_user.avatar
			? `https://cdn.discordapp.com/avatars/${data.discord_user.id}/${data.discord_user.avatar}.png?size=64`
			: null
	);

	function formatElapsed(startMs: number): string {
		const totalSec = Math.max(0, Math.floor((now - startMs) / 1000));
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		const s = totalSec % 60;
		if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} elapsed`;
		return `${m}:${s.toString().padStart(2, '0')} elapsed`;
	}
</script>

{#if activityOnly}
	{#if status === 'loading'}
		<p class="text-sm text-dim">Checking Discord…</p>
	{:else if status === 'error' || !data}
		<p class="text-sm text-dim">Discord status unavailable.</p>
	{:else if activity}
		<div class="flex items-center gap-3">
			{#if activityImage}
				<img src={activityImage} alt="" class="h-14 w-14 shrink-0 rounded-md object-cover" />
			{:else}
				<span class="grid h-14 w-14 shrink-0 place-items-center rounded-md bg-surface-2 text-xs text-dim">
					{activity.name.slice(0, 1).toUpperCase()}
				</span>
			{/if}
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium text-white">{activity.name}</p>
				{#if activity.details}
					<p class="truncate text-xs text-dim">{activity.details}</p>
				{/if}
				{#if activity.state}
					<p class="truncate text-xs text-dim">{activity.state}</p>
				{/if}
				{#if activity.timestamps?.start}
					<p class="mt-1 text-xs text-dim">{formatElapsed(activity.timestamps.start)}</p>
				{/if}
			</div>
		</div>
	{:else}
		<p class="text-sm text-dim">Not doing anything on Discord right now.</p>
	{/if}
{:else if compact}
	{#if status === 'loading'}
		<p class="text-xs text-dim">Checking Discord…</p>
	{:else if status === 'error' || !data}
		<p class="text-xs text-dim">Discord unavailable.</p>
	{:else}
		<div class="flex items-center gap-1.5 text-xs text-dim">
			<span class={`h-2 w-2 rounded-full ${statusColor[data.discord_status]}`} aria-hidden="true"
			></span>
			<span>{statusLabel[data.discord_status]}</span>
			{#if customStatus?.state || customStatus?.emoji?.name}
				<span aria-hidden="true">·</span>
				<span class="truncate">
					{#if customStatus.emoji?.name && !customStatus.emoji.id}{customStatus.emoji
							.name}{' '}{/if}{customStatus.state ?? ''}
				</span>
			{/if}
		</div>
	{/if}
{:else if status === 'loading'}
	<p class="text-sm text-dim">Checking Discord status…</p>
{:else if status === 'error' || !data}
	<p class="text-sm text-dim">Discord status unavailable.</p>
{:else}
	<div class="flex items-start gap-3">
		<div class="relative shrink-0">
			{#if avatarUrl}
				<img src={avatarUrl} alt="" class="h-10 w-10 rounded-full object-cover" />
			{:else}
				<span class="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-xs text-dim">
					{(data.discord_user.global_name ?? data.discord_user.username).slice(0, 1).toUpperCase()}
				</span>
			{/if}
			<span
				class={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full ring-2 ring-surface ${statusColor[data.discord_status]}`}
				aria-hidden="true"
			></span>
		</div>

		<div class="min-w-0 flex-1 text-sm">
			<div class="flex items-center gap-2">
				<span class="font-medium text-white">
					{data.discord_user.global_name ?? data.discord_user.username}
				</span>
				<span class="text-xs text-dim">{statusLabel[data.discord_status]}</span>
				{#if data.active_on_discord_desktop || data.active_on_discord_mobile || data.active_on_discord_web}
					<span class="flex items-center gap-1 text-dim">
						{#if data.active_on_discord_desktop}
							<Monitor size={12} aria-label="Active on desktop" />
						{/if}
						{#if data.active_on_discord_mobile}
							<Smartphone size={12} aria-label="Active on mobile" />
						{/if}
						{#if data.active_on_discord_web}
							<Globe size={12} aria-label="Active on web" />
						{/if}
					</span>
				{/if}
			</div>

			{#if customStatus?.state || customStatus?.emoji?.name}
				<p class="mt-0.5 truncate text-dim">
					{#if customStatus.emoji?.name && !customStatus.emoji.id}{customStatus.emoji.name}{' '}{/if}
					{customStatus.state ?? ''}
				</p>
			{/if}

			{#if activity}
				<div class="mt-3 flex items-center gap-2.5 border-t border-border pt-3">
					{#if activityImage}
						<img src={activityImage} alt="" class="h-9 w-9 shrink-0 rounded-md object-cover" />
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-gray">{activity.name}</p>
						{#if activity.details}
							<p class="truncate text-xs text-dim">{activity.details}</p>
						{/if}
						{#if activity.state}
							<p class="truncate text-xs text-dim">{activity.state}</p>
						{/if}
						{#if activity.timestamps?.start}
							<p class="text-xs text-dim">{formatElapsed(activity.timestamps.start)}</p>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
{/if}
