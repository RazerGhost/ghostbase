import { site } from '$lib/config';

// Single shared Lanyard poller, used by DiscordPresence, SpotifyWidget, and
// ListeningNowCard. Previously each of those hit Spotify's own API through
// our server (via /api/spotify), and since that route shares one refresh
// token across every visitor, three independent polling loops per page load
// (plus one per browser tab left open) was enough to trip Spotify's rate
// limit and land the account in a cooldown. Lanyard already tracks Spotify
// listening as part of Discord Rich Presence (pushed from Discord's gateway,
// not polled from Spotify), so reading it from there removes Spotify's API
// from this path entirely — at the cost of only working while the account is
// online in Discord with Spotify activity sharing enabled.
export interface LanyardSpotify {
	track_id: string;
	timestamps: { start: number; end: number };
	song: string;
	artist: string;
	album: string;
	album_art_url: string;
}

export interface LanyardActivity {
	name: string;
	type: number;
	state?: string;
	details?: string;
	application_id?: string;
	emoji?: { name: string; id?: string };
	timestamps?: { start?: number; end?: number };
	assets?: {
		large_image?: string;
		large_text?: string;
		small_image?: string;
		small_text?: string;
	};
}

export interface LanyardData {
	discord_status: 'online' | 'idle' | 'dnd' | 'offline';
	discord_user: { id: string; username: string; global_name: string | null; avatar: string | null };
	activities: LanyardActivity[];
	active_on_discord_desktop: boolean;
	active_on_discord_mobile: boolean;
	active_on_discord_web: boolean;
	listening_to_spotify: boolean;
	spotify: LanyardSpotify | null;
}

let data = $state<LanyardData | null>(null);
let status = $state<'loading' | 'ready' | 'error'>('loading');

let subscribers = 0;
let interval: ReturnType<typeof setInterval> | undefined;
let onVisible: (() => void) | undefined;

const POLL_MS = 20_000;

async function poll() {
	try {
		const res = await fetch(`https://api.lanyard.rest/v1/users/${site.discordUserId}`);
		if (!res.ok) throw new Error(`Lanyard returned ${res.status}`);
		const json = await res.json();
		if (!json.success) throw new Error('Lanyard: user not found in cache');
		data = json.data;
		status = 'ready';
	} catch {
		status = 'error';
	}
}

// Reference-counted so the interval only runs while at least one component
// on the page cares, and starts immediately (rather than waiting a full
// POLL_MS) the moment the first one mounts.
function start() {
	if (subscribers === 0) {
		poll();
		interval = setInterval(poll, POLL_MS);
		onVisible = () => {
			if (document.visibilityState === 'visible') poll();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);
	}
	subscribers++;
}

function stop() {
	subscribers = Math.max(0, subscribers - 1);
	if (subscribers === 0) {
		clearInterval(interval);
		if (onVisible) {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('focus', onVisible);
		}
	}
}

export function useLanyard() {
	return {
		get data() {
			return data;
		},
		get status() {
			return status;
		},
		start,
		stop
	};
}
