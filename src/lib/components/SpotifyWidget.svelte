<script lang="ts">
	import Music from '@lucide/svelte/icons/music';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Minus from '@lucide/svelte/icons/minus';
	import History from '@lucide/svelte/icons/history';
	import { useLanyard } from '$lib/stores/lanyard.svelte';

	interface RecentItem {
		track: string;
		artist?: string;
		url?: string;
		albumArt?: string;
		playedAt: string;
	}

	function dateKey(d = new Date()) {
		// en-CA locale formats as YYYY-MM-DD, a stable sortable key.
		return d.toLocaleDateString('en-CA');
	}

	function loadListenedMs(): number {
		if (typeof localStorage === 'undefined') return 0;
		const raw = localStorage.getItem(`spotify-listened-${dateKey()}`);
		return raw ? Number(raw) : 0;
	}

	function saveListenedMs(ms: number) {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(`spotify-listened-${dateKey()}`, String(Math.round(ms)));
	}

	function formatClock(ms: number) {
		const totalSec = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function formatListened(ms: number) {
		const mins = Math.floor(ms / 60_000);
		if (mins < 1) return 'under a minute';
		if (mins < 60) return `${mins}m`;
		return `${Math.floor(mins / 60)}h ${mins % 60}m`;
	}

	const lanyard = useLanyard();
	let recent = $state<RecentItem[]>([]);
	let recentAvailable = $state(false);
	let expanded = $state(false);
	let now = $state(Date.now());
	let listenedMsToday = $state(loadListenedMs());

	let lastTrackId = '';

	async function pollRecent() {
		try {
			const res = await fetch('/api/spotify/recent');
			const body = await res.json();
			recentAvailable = Boolean(body.available);
			recent = body.items ?? [];
		} catch {
			recentAvailable = false;
		}
	}

	// Currently-playing state comes from Lanyard (Discord's Rich Presence
	// gateway push, relayed by lanyard.rest) instead of polling Spotify's own
	// API — see stores/lanyard.svelte.ts for why. "Recently played" history
	// still needs a real Spotify scope Lanyard doesn't expose, so that part
	// keeps hitting /api/spotify/recent, just at a much lower rate (60s here,
	// vs. the old currently-playing poll which tightened down to every 4s).
	const spotify = $derived(lanyard.data?.listening_to_spotify ? lanyard.data.spotify : null);
	const playing = $derived(Boolean(spotify));
	const track = $derived(spotify?.song);
	const artist = $derived(spotify?.artist);
	const albumArt = $derived(spotify?.album_art_url);
	const trackUrl = $derived(spotify ? `https://open.spotify.com/track/${spotify.track_id}` : undefined);
	const durationMs = $derived(spotify ? spotify.timestamps.end - spotify.timestamps.start : undefined);

	$effect(() => {
		lanyard.start();
		pollRecent();
		const recentInterval = setInterval(pollRecent, 60_000);
		return () => {
			lanyard.stop();
			clearInterval(recentInterval);
		};
	});

	// A track change (as observed via Lanyard) means the previous one just
	// finished — refresh recently-played history to pick it up.
	$effect(() => {
		const id = spotify?.track_id ?? '';
		if (id && id !== lastTrackId) {
			if (lastTrackId) pollRecent();
			lastTrackId = id;
		}
	});

	// Collapse the expanded card back to the pill if playback stops.
	$effect(() => {
		if (!playing) expanded = false;
	});

	// Local 1s ticker while playing: drives the progress bar between Lanyard
	// polls and accumulates today's listening time, without hitting any API.
	// listenedDate tracks which day the counter belongs to — a tab left open
	// across midnight resets to zero instead of carrying yesterday's total
	// into the new day's localStorage key.
	let listenedDate = dateKey();
	$effect(() => {
		if (!playing) return;
		let last = Date.now();
		const id = setInterval(() => {
			const current = Date.now();
			const today = dateKey();
			if (today !== listenedDate) {
				listenedDate = today;
				listenedMsToday = 0;
			}
			listenedMsToday += current - last;
			last = current;
			now = current;
			saveListenedMs(listenedMsToday);
		}, 1000);
		return () => clearInterval(id);
	});

	// Computed straight from Lanyard's absolute start/end timestamps rather
	// than "progress at last fetch + elapsed", so it stays accurate regardless
	// of how stale the last Lanyard poll is.
	const localProgressMs = $derived.by(() => {
		if (!spotify || durationMs == null) return 0;
		return Math.min(durationMs, Math.max(0, now - spotify.timestamps.start));
	});

	const progressPct = $derived(durationMs ? Math.min(100, (localProgressMs / durationMs) * 100) : 0);
</script>

{#if playing && track}
	<div class="fixed bottom-6 left-6 z-10 flex flex-col items-start gap-2" data-hero-reveal="0">
		{#if expanded}
			<div
				class="card w-80 rounded-lg border border-border bg-surface/80 p-3 shadow-[var(--shadow-card-hover)] backdrop-blur-md"
			>
				<div class="flex items-center gap-3">
					{#if albumArt}
						<img src={albumArt} alt="" class="h-12 w-12 shrink-0 rounded-md object-cover" />
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium text-white">{track}</p>
						<p class="truncate text-xs text-dim">{artist}</p>
					</div>
					<a
						href={trackUrl}
						target="_blank"
						rel="noreferrer"
						aria-label="Open in Spotify"
						class="shrink-0 rounded-full p-1.5 text-dim transition-colors hover:text-primary"
					>
						<ExternalLink size={15} aria-hidden="true" />
					</a>
					<button
						type="button"
						aria-label="Minimize now-playing widget"
						class="shrink-0 rounded-full p-1.5 text-dim transition-colors hover:text-white"
						onclick={() => (expanded = false)}
					>
						<Minus size={15} aria-hidden="true" />
					</button>
				</div>

				{#if durationMs}
					<div class="mt-3">
						<div class="h-1 w-full overflow-hidden rounded-full bg-surface-2">
							<div
								class="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
								style:width="{progressPct}%"
							></div>
						</div>
						<div class="mt-1 flex justify-between text-[11px] text-dim">
							<span>{formatClock(localProgressMs)}</span>
							<span>{formatClock(durationMs)}</span>
						</div>
					</div>
				{/if}

				<p class="mt-3 text-[11px] text-dim">
					{formatListened(listenedMsToday)} listened today
				</p>

				{#if recentAvailable && recent.length}
					<div class="mt-3 border-t border-border pt-3">
						<p class="flex items-center gap-1.5 text-[11px] font-medium text-dim">
							<History size={12} aria-hidden="true" /> Recently played
						</p>
						<ul class="mt-2 grid gap-2">
							{#each recent as item (item.playedAt)}
								<li>
									<a
										href={item.url}
										target="_blank"
										rel="noreferrer"
										class="flex items-center gap-2 rounded-md transition-colors hover:bg-surface-2"
									>
										{#if item.albumArt}
											<img
												src={item.albumArt}
												alt=""
												class="h-7 w-7 shrink-0 rounded object-cover"
											/>
										{/if}
										<span class="min-w-0 flex-1">
											<span class="block truncate text-xs text-gray">{item.track}</span>
										</span>
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{:else}
			<button
				type="button"
				aria-label={`Now playing: ${track} by ${artist}. Click to expand.`}
				class="card flex items-center gap-2 rounded-full border border-border bg-surface/80 py-1.5 pr-4 pl-1.5 shadow-[var(--shadow-card-hover)] backdrop-blur-md transition-colors hover:border-primary"
				onclick={() => (expanded = true)}
			>
				<span class="relative h-8 w-8 shrink-0">
					{#if albumArt}
						<img src={albumArt} alt="" class="h-8 w-8 rounded-full object-cover" />
					{:else}
						<span class="grid h-8 w-8 place-items-center rounded-full bg-surface-2">
							<Music size={14} class="text-primary" aria-hidden="true" />
						</span>
					{/if}
					<span
						class="absolute -right-0.5 -bottom-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-surface"
						aria-hidden="true"
					>
						<span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>
					</span>
				</span>
				<span class="max-w-[9rem] truncate text-xs font-medium text-white">{track}</span>
			</button>
		{/if}
	</div>
{/if}
