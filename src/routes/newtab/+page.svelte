<script lang="ts">
	import DiscordPresence from '$lib/components/DiscordPresence.svelte';
	import ListeningNowCard from '$lib/components/ListeningNowCard.svelte';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import Wrench from '@lucide/svelte/icons/wrench';
	import Clapperboard from '@lucide/svelte/icons/clapperboard';
	import Music from '@lucide/svelte/icons/music';
	import Search from '@lucide/svelte/icons/search';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import Settings from '@lucide/svelte/icons/settings';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import CloudSun from '@lucide/svelte/icons/cloud-sun';
	import Timer from '@lucide/svelte/icons/timer';
	import Star from '@lucide/svelte/icons/star';
	import Shuffle from '@lucide/svelte/icons/shuffle';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Eye from '@lucide/svelte/icons/eye';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Link2 from '@lucide/svelte/icons/link-2';
	import Unlink from '@lucide/svelte/icons/unlink';
	import Lock from '@lucide/svelte/icons/lock';
	import MoreVertical from '@lucide/svelte/icons/more-vertical';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { enhance } from '$app/forms';
	import { DragDropProvider, createDraggable } from '@dnd-kit/svelte';
	import { Feedback } from '@dnd-kit/dom';
	import { navLinks } from '$lib/config';
	import {
		getFloatPosition,
		setFloatPosition,
		clearFloatPosition,
		resetAllFloatPositions,
		getHiddenWidgetIds,
		setHiddenWidgetIds,
		resetHiddenWidgets,
		getWidgetGroups,
		setWidgetGroups,
		resetWidgetGroups,
		getMergeHintDismissed,
		setMergeHintDismissed,
		getQuickLinksSortByClicks,
		type FloatPosition,
		type WidgetGroup as StoredWidgetGroup
	} from '$lib/client/newtab-layout';
	import {
		gridDimensions,
		resolveColFr,
		setColFr,
		edgeDockTarget,
		insertCell,
		removeCell,
		repackRowUnderSpan,
		type DockEdge,
		type WidgetGroup,
		type GroupCell
	} from '$lib/client/widget-grid';
	import QuickLinksModal from '$lib/components/QuickLinksModal.svelte';
	import QuickLinkIcon from '$lib/components/QuickLinkIcon.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let settingsOpen = $state(false);
	let queryInput = $state(data.unsplashQuery);
	let icsUrlInput = $state(data.icsUrl ?? '');

	// Notes is intentionally left out of the site-wide nav (it's a private,
	// login-gated route) — but it belongs on this personal dashboard, so it's
	// appended here rather than added to the shared navLinks config.
	const dashboardLinks = [...navLinks, { label: 'Notes', href: '/notes' }];

	const linkIcons = {
		Projects: FolderGit2,
		Devlog: NotebookPen,
		Gear: Wrench,
		Watchlist: Clapperboard,
		Listens: Music,
		Notes: StickyNote
	} as const;

	// Search bangs, listed here (rather than a plain Record) so the same data
	// can drive both dispatch and the "!" autocomplete hint in the search
	// dropdown. Anything else (or no bang) falls through to DuckDuckGo.
	// '!notes' is a local bang — it searches this site's own private notes
	// instead of the open web, so its run() is a relative path, not a full URL.
	type Bang = { trigger: string; label: string; run: (q: string) => string };
	const BANGS: Bang[] = [
		{ trigger: '!d', label: 'DuckDuckGo', run: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
		{
			trigger: '!yt',
			label: 'YouTube',
			run: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
		},
		{ trigger: '!gh', label: 'GitHub', run: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
		{
			trigger: '!w',
			label: 'Wikipedia',
			run: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`
		},
		{
			trigger: '!mdn',
			label: 'MDN',
			run: (q) => `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}`
		},
		{
			trigger: '!maps',
			label: 'Google Maps',
			run: (q) => `https://www.google.com/maps/search/${encodeURIComponent(q)}`
		},
		{ trigger: '!notes', label: 'Notes', run: (q) => `/notes?q=${encodeURIComponent(q)}` }
	];
	const bangs: Record<string, (q: string) => string> = Object.fromEntries(
		BANGS.map((b) => [b.trigger, b.run])
	);

	let query = $state('');
	let searchInputEl = $state<HTMLInputElement | undefined>();

	// Fire-and-forget — logs the search before the page navigates away, so we
	// don't hold up the redirect waiting on a round trip.
	function logSearch(q: string) {
		const body = new FormData();
		body.set('query', q);
		fetch('?/logSearch', { method: 'POST', body }).catch(() => {});
	}

	// Pasting or typing an actual URL (or a bare domain like "github.com")
	// should navigate straight there instead of searching DuckDuckGo for it.
	function urlToOpen(input: string): string | null {
		if (/^https?:\/\/\S+$/i.test(input)) return input;
		if (/\s/.test(input)) return null;
		const isBareDomain = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/\S*)?$/i.test(input);
		return isBareDomain ? `https://${input}` : null;
	}

	// Resolves what a raw query string should navigate to — split out from
	// runSearch so the open-in-new-tab modifier (Ctrl/Cmd+Enter) can reuse the
	// exact same resolution logic without duplicating it.
	function resolveSearchUrl(trimmed: string): string {
		const directUrl = urlToOpen(trimmed);
		if (directUrl) return directUrl;

		const [maybeBang, ...rest] = trimmed.split(' ');
		const bang = bangs[maybeBang.toLowerCase()];
		if (bang && rest.length) return bang(rest.join(' '));

		return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
	}

	function navigateTo(url: string, openInNewTab: boolean) {
		if (openInNewTab) window.open(url, '_blank', 'noopener');
		else window.location.href = url;
	}

	function runSearch(raw: string, openInNewTab = false) {
		const trimmed = raw.trim();
		if (!trimmed) return;
		logSearch(trimmed);
		navigateTo(resolveSearchUrl(trimmed), openInNewTab);
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		if (selectedIndex >= 0 && suggestions[selectedIndex]) {
			chooseSuggestion(suggestions[selectedIndex]);
			return;
		}
		runSearch(query);
	}

	// "/" focuses search from anywhere on the page (skipped while already
	// typing in a field); Escape clears and blurs the search box; a bare
	// single-character key matching a quick link's shortcut navigates there.
	function handleGlobalKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
		if (event.key === '/' && !isTyping) {
			event.preventDefault();
			searchInputEl?.focus();
		} else if (event.key === 'Escape' && target === searchInputEl) {
			query = '';
			searchFocused = false;
			searchInputEl?.blur();
		} else if (!isTyping && event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'l') {
			// Alt+L toggles whether widget cards can be dragged at all — a
			// quick "stop me from bumping things" lock, see dragEnabled above.
			event.preventDefault();
			dragEnabled = !dragEnabled;
		} else if (!isTyping && !event.ctrlKey && !event.altKey && !event.metaKey) {
			const link = quickLinkForShortcut(event.key);
			if (link) {
				event.preventDefault();
				trackQuickLinkClick(link.id);
				window.location.href = link.url;
			}
		}
	}

	// --- Inline calculator ---------------------------------------------------
	// A small hand-rolled recursive-descent parser (never eval) for +-*/() —
	// just enough to let "12 * (4 + 1)" resolve inline in the search dropdown
	// instead of round-tripping to a web search for basic arithmetic.
	function tokenizeArithmetic(expr: string): string[] {
		return expr.match(/\d+\.?\d*|\.\d+|[+\-*/()]/g) ?? [];
	}

	class ArithmeticParser {
		private pos = 0;
		private tokens: string[];
		constructor(tokens: string[]) {
			this.tokens = tokens;
		}

		private peek() {
			return this.tokens[this.pos];
		}
		private next() {
			return this.tokens[this.pos++];
		}

		parse(): number {
			const value = this.parseExpression();
			if (this.pos !== this.tokens.length) throw new Error('Unexpected trailing input');
			return value;
		}
		private parseExpression(): number {
			let value = this.parseTerm();
			while (this.peek() === '+' || this.peek() === '-') {
				const op = this.next();
				const rhs = this.parseTerm();
				value = op === '+' ? value + rhs : value - rhs;
			}
			return value;
		}
		private parseTerm(): number {
			let value = this.parseFactor();
			while (this.peek() === '*' || this.peek() === '/') {
				const op = this.next();
				const rhs = this.parseFactor();
				value = op === '*' ? value * rhs : value / rhs;
			}
			return value;
		}
		private parseFactor(): number {
			if (this.peek() === '-') {
				this.next();
				return -this.parseFactor();
			}
			if (this.peek() === '(') {
				this.next();
				const value = this.parseExpression();
				if (this.next() !== ')') throw new Error('Expected )');
				return value;
			}
			const token = this.next();
			const num = token === undefined ? NaN : Number(token);
			if (Number.isNaN(num)) throw new Error('Expected a number');
			return num;
		}
	}

	// Requires at least one operator so a bare number (or a recent search that
	// happens to be all digits) doesn't get hijacked into "calculator" mode.
	function evaluateArithmetic(expr: string): number | null {
		if (!/^[\d\s+\-*/().]+$/.test(expr) || !/[+\-*/]/.test(expr)) return null;
		try {
			const tokens = tokenizeArithmetic(expr);
			if (!tokens.length) return null;
			const value = new ArithmeticParser(tokens).parse();
			return Number.isFinite(value) ? value : null;
		} catch {
			return null;
		}
	}

	// Strips floating-point noise (e.g. 0.1 + 0.2) without turning legitimate
	// long decimals into scientific notation.
	function formatCalcValue(value: number): string {
		return Number(value.toFixed(10)).toString();
	}

	// --- Search suggestions dropdown ---------------------------------------
	// Combines recent searches, matching quick links, and (when the query
	// starts with "!") a hint list of available bangs — replaces the old flat
	// row of recent-search pills with a real, keyboard-navigable omnibox.
	type Suggestion =
		| { kind: 'search'; value: string }
		| { kind: 'link'; id: number; label: string; url: string }
		| { kind: 'bang'; trigger: string; label: string }
		| { kind: 'calc'; expression: string; value: number };

	let searchFocused = $state(false);
	let selectedIndex = $state(-1);

	// Client-side removal is optimistic — data.recentSearches is server load
	// data and won't reflect the delete until the next full reload, so this
	// hides it from the dropdown immediately while the fetch runs in the
	// background.
	let removedSearches = $state<Set<string>>(new Set());
	const visibleRecentSearches = $derived(data.recentSearches.filter((s) => !removedSearches.has(s)));

	function removeSearchSuggestion(value: string) {
		removedSearches = new Set([...removedSearches, value]);
		const body = new FormData();
		body.set('query', value);
		fetch('?/removeSearch', { method: 'POST', body }).catch(() => {});
	}

	const suggestions = $derived.by((): Suggestion[] => {
		const trimmed = query.trim();

		if (trimmed.startsWith('!')) {
			const partial = trimmed.slice(1).toLowerCase();
			return BANGS.filter((b) => b.trigger.slice(1).toLowerCase().startsWith(partial)).map(
				(b): Suggestion => ({ kind: 'bang', trigger: b.trigger, label: b.label })
			);
		}

		if (!trimmed) {
			return visibleRecentSearches.map((value): Suggestion => ({ kind: 'search', value }));
		}

		const calcValue = evaluateArithmetic(trimmed);
		const calcSuggestion: Suggestion[] =
			calcValue !== null ? [{ kind: 'calc', expression: trimmed, value: calcValue }] : [];

		const lower = trimmed.toLowerCase();
		const searchMatches: Suggestion[] = visibleRecentSearches
			.filter((s) => s.toLowerCase().includes(lower))
			.map((value) => ({ kind: 'search', value }));
		const linkMatches: Suggestion[] = data.quickLinks
			.filter((l) => l.label.toLowerCase().includes(lower))
			.map((l) => ({ kind: 'link', id: l.id, label: l.label, url: l.url }));

		return [...calcSuggestion, ...searchMatches, ...linkMatches].slice(0, 8);
	});

	const dropdownOpen = $derived(searchFocused && suggestions.length > 0);

	// Keeps the highlighted row in range whenever the suggestion list itself
	// changes (new keystroke, focus, etc.) rather than pointing at a row that
	// no longer exists — except a calculator result, which auto-highlights so
	// a plain Enter copies it immediately (standard omnibox behavior).
	$effect(() => {
		selectedIndex = suggestions[0]?.kind === 'calc' ? 0 : -1;
	});

	let calcCopied = $state(false);

	function chooseSuggestion(suggestion: Suggestion, openInNewTab = false) {
		if (suggestion.kind === 'search') {
			runSearch(suggestion.value, openInNewTab);
		} else if (suggestion.kind === 'link') {
			trackQuickLinkClick(suggestion.id);
			navigateTo(suggestion.url, openInNewTab);
		} else if (suggestion.kind === 'calc') {
			navigator.clipboard?.writeText(formatCalcValue(suggestion.value)).catch(() => {});
			calcCopied = true;
			setTimeout(() => (calcCopied = false), 1500);
		} else {
			// Bang hint — fill the trigger in and keep typing rather than
			// searching immediately, since a bang alone isn't a useful query.
			query = `${suggestion.trigger} `;
			searchInputEl?.focus();
		}
	}

	// Ctrl/Cmd+Enter opens the resolved destination in a new tab instead of
	// navigating away from the dashboard — checked ahead of the dropdownOpen
	// guard below since it must also work with the dropdown closed (a plain
	// query with no suggestions showing).
	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			if (selectedIndex >= 0 && suggestions[selectedIndex]) {
				chooseSuggestion(suggestions[selectedIndex], true);
			} else {
				runSearch(query, true);
			}
			return;
		}

		if (!dropdownOpen) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, -1);
		}
	}

	// Delayed so a click on a dropdown suggestion (which the button's
	// onmousedown already guards against stealing focus) has a chance to
	// register before the dropdown disappears.
	function handleSearchBlur() {
		setTimeout(() => {
			searchFocused = false;
		}, 150);
	}

	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => {
			now = new Date();
		}, 1000);
		return () => clearInterval(timer);
	});

	const timeString = $derived(
		now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
	);
	const greeting = $derived.by(() => {
		const hour = now.getHours();
		if (hour < 5) return 'Still up';
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	// --- Quick links -----------------------------------------------------
	// Management UI (add/edit/reorder/icon picker) lives in QuickLinksModal —
	// this page just owns whether it's open, the display-only sort toggle
	// (persisted per-device, doesn't touch the server-side `position` the
	// modal's up/down buttons reorder), and rendering the link pills.
	let quickLinksOpen = $state(false);

	function faviconFor(url: string): string | null {
		try {
			const host = new URL(url).hostname;
			return `https://icons.duckduckgo.com/ip3/${host}.ico`;
		} catch {
			return null;
		}
	}

	// Fire-and-forget click tracking — doesn't block the anchor's own
	// navigation, just records it server-side for the clicks column.
	function trackQuickLinkClick(id: number) {
		const body = new FormData();
		body.set('id', String(id));
		fetch('?/clickQuickLink', { method: 'POST', body }).catch(() => {});
	}

	let sortByClicks = $state(false);
	$effect(() => {
		sortByClicks = getQuickLinksSortByClicks();
	});
	const displayedQuickLinks = $derived(
		sortByClicks ? [...data.quickLinks].sort((a, b) => b.clicks - a.clicks) : data.quickLinks
	);

	// Single-character keyboard shortcuts (e.g. "g" -> GitHub) — skipped
	// while typing in a field, same guard as the "/" search-focus shortcut.
	function quickLinkForShortcut(key: string) {
		return data.quickLinks.find((l) => l.shortcut && l.shortcut === key.toLowerCase());
	}

	// --- Weather (client-side, no API key — Open-Meteo) -------------------
	type WeatherState = { tempC: number; code: number } | 'denied' | 'unavailable' | 'timeout' | 'error' | null;
	let weather = $state<WeatherState>(null);

	// "Today 3:00 PM" / "Tomorrow" (all-day) / "Jul 26" for anything further out.
	function agendaLabel(start: Date, allDay: boolean): string {
		const now = new Date();
		const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const diffDays = Math.round((startDay.getTime() - today.getTime()) / 86400000);
		const dayLabel =
			diffDays === 0
				? 'Today'
				: diffDays === 1
					? 'Tomorrow'
					: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		if (allDay) return dayLabel;
		return `${dayLabel} ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
	}

	function weatherLabel(code: number): string {
		if (code === 0) return 'Clear';
		if (code <= 3) return 'Partly cloudy';
		if (code <= 48) return 'Foggy';
		if (code <= 67) return 'Rainy';
		if (code <= 77) return 'Snowy';
		if (code <= 82) return 'Showers';
		if (code <= 99) return 'Stormy';
		return 'Unknown';
	}

	async function fetchWeather(latitude: number, longitude: number): Promise<boolean> {
		try {
			const res = await fetch(
				`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`
			);
			if (!res.ok) return false;
			const body = await res.json();
			weather = { tempC: Math.round(body.current.temperature_2m), code: body.current.weather_code };
			return true;
		} catch {
			return false;
		}
	}

	// IP-based lookup — coarser (city-level, not GPS-precise) but instant and
	// permission-free, so it's used as the fallback whenever the browser's
	// Geolocation API is denied, unavailable, or just times out (which in
	// practice was the common case — no prompt ever getting a real GPS/network
	// fix back within a few seconds).
	async function fetchWeatherByIp(): Promise<boolean> {
		try {
			const res = await fetch('https://ipwho.is/');
			if (!res.ok) return false;
			const body = await res.json();
			if (!body.success || typeof body.latitude !== 'number' || typeof body.longitude !== 'number') return false;
			return fetchWeather(body.latitude, body.longitude);
		} catch {
			return false;
		}
	}

	function loadWeather() {
		weather = null;

		if (!navigator.geolocation) {
			fetchWeatherByIp().then((ok) => {
				if (!ok) weather = 'error';
			});
			return;
		}

		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				const ok = await fetchWeather(pos.coords.latitude, pos.coords.longitude);
				if (!ok) weather = 'error';
			},
			(err) => {
				// GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 =
				// POSITION_UNAVAILABLE, 3 = TIMEOUT. Any of these fall back to
				// IP-based geolocation rather than immediately giving up.
				fetchWeatherByIp().then((ok) => {
					if (ok) return;
					if (err.code === err.PERMISSION_DENIED) weather = 'denied';
					else if (err.code === err.TIMEOUT) weather = 'timeout';
					else weather = 'unavailable';
				});
			},
			// A short timeout is fine now that a fast IP-based fallback exists —
			// no reason to make someone wait 15s to find out GPS isn't working.
			{ timeout: 5000, maximumAge: 10 * 60 * 1000, enableHighAccuracy: false }
		);
	}

	$effect(() => {
		loadWeather();
	});

	// --- Background photo cycling/favoriting -------------------------------
	let currentPhoto = $state(data.photo);
	let favoritedOverride = $state<boolean | null>(null);
	const currentPhotoId = $derived(data.photoHistory.find((p) => p.url === currentPhoto?.url)?.id ?? null);
	const currentPhotoFavorited = $derived(
		favoritedOverride ?? data.photoHistory.find((p) => p.url === currentPhoto?.url)?.favorited ?? false
	);

	function toggleFavoritePhoto() {
		if (!currentPhotoId) return;
		favoritedOverride = !currentPhotoFavorited;
		const body = new FormData();
		body.set('id', String(currentPhotoId));
		fetch('?/favoritePhoto', { method: 'POST', body }).catch(() => {});
	}

	const favoritedPhotos = $derived(data.photoHistory.filter((p) => p.favorited));

	// --- Pomodoro timer (client-only state, completed segments logged server-side) --------------------
	const WORK_SECONDS = 25 * 60;
	const BREAK_SECONDS = 5 * 60;
	let pomodoroSecondsLeft = $state(WORK_SECONDS);
	let pomodoroRunning = $state(false);
	let pomodoroOnBreak = $state(false);
	let segmentStartedAt = $state<string | null>(null);

	function logFocusSegment(kind: 'focus' | 'break', completed: boolean) {
		if (!segmentStartedAt) return;
		const body = new FormData();
		body.set('kind', kind);
		body.set('completed', String(completed));
		body.set('startedAt', segmentStartedAt);
		body.set('endedAt', new Date().toISOString());
		fetch('?/logFocusSession', { method: 'POST', body }).catch(() => {});
	}

	$effect(() => {
		if (!pomodoroRunning) return;
		if (!segmentStartedAt) segmentStartedAt = new Date().toISOString();
		const interval = setInterval(() => {
			if (pomodoroSecondsLeft <= 1) {
				logFocusSegment(pomodoroOnBreak ? 'break' : 'focus', true);
				pomodoroOnBreak = !pomodoroOnBreak;
				pomodoroSecondsLeft = pomodoroOnBreak ? BREAK_SECONDS : WORK_SECONDS;
				segmentStartedAt = new Date().toISOString();
			} else {
				pomodoroSecondsLeft -= 1;
			}
		}, 1000);
		return () => clearInterval(interval);
	});

	function togglePomodoro() {
		pomodoroRunning = !pomodoroRunning;
		if (!pomodoroRunning) {
			logFocusSegment(pomodoroOnBreak ? 'break' : 'focus', false);
			segmentStartedAt = null;
		}
	}

	function resetPomodoro() {
		if (pomodoroRunning) logFocusSegment(pomodoroOnBreak ? 'break' : 'focus', false);
		pomodoroRunning = false;
		pomodoroOnBreak = false;
		pomodoroSecondsLeft = WORK_SECONDS;
		segmentStartedAt = null;
	}

	const pomodoroTimeString = $derived(
		`${Math.floor(pomodoroSecondsLeft / 60)
			.toString()
			.padStart(2, '0')}:${(pomodoroSecondsLeft % 60).toString().padStart(2, '0')}`
	);

	// --- Quick note capture --------------------------------------------
	let noteBody = $state('');
	let noteSaved = $state(false);

	// --- To-do checklist --------------------------------------------------
	// Done items sink to the bottom (display-only sort — doesn't touch the
	// server-side `position`, same idea as the quick links click-sort toggle).
	let todoBody = $state('');
	const displayedTodoItems = $derived(
		[...data.todoItems].sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position)
	);

	// --- Free-floating / mergeable widgets ----------------------------------
	// Every widget lives as its own card, freely draggable anywhere on the
	// page — there's no grid to "belong" to. A card remembers its spot
	// per-device via localStorage (see $lib/client/newtab-layout.ts) —
	// deliberately not synced server-side, this is layout preference, not
	// data. Dropping one card onto another merges them into a single
	// combined card (see mergeSlots) rather than reordering, since position
	// on a freeform canvas already *is* the arrangement.
	const WIDGET_IDS = [
		'now-playing',
		'discord',
		'watching',
		'right-now',
		'recent-notes',
		'weather',
		'focus',
		'todo',
		'agenda',
		'note'
	] as const;
	type WidgetId = (typeof WIDGET_IDS)[number];

	const WIDGET_META: Record<WidgetId, { label: string; icon: typeof Music | null }> = {
		'right-now': { label: 'Right now', icon: null },
		'now-playing': { label: 'Now playing', icon: Music },
		discord: { label: 'Discord', icon: null },
		'recent-notes': { label: 'Recent notes', icon: ScrollText },
		watching: { label: 'Currently watching', icon: Clapperboard },
		weather: { label: 'Weather', icon: CloudSun },
		focus: { label: 'Focus timer', icon: Timer },
		todo: { label: 'To-do', icon: ListTodo },
		agenda: { label: 'Agenda', icon: CalendarDays },
		note: { label: 'Quick note', icon: StickyNote }
	};

	function widgetHasData(id: WidgetId): boolean {
		if (id === 'right-now') return data.statusItems.length > 0;
		if (id === 'watching') return data.watching.length > 0;
		if (id === 'agenda') return data.agenda.length > 0;
		return true;
	}
	function widgetVisible(id: WidgetId): boolean {
		return !hiddenIds.has(id) && widgetHasData(id);
	}

	// A "slot" is one rendered card — either a single widget, or (after
	// docking cards together, see mergeAtEdge below) a small 2D grid of
	// widget ids sharing one card. Position/hiding are keyed off a slot's
	// `key` rather than a raw widget id, so a merged card behaves as one
	// unit. `group` is null for a standalone card.
	type Slot = { key: string; ids: WidgetId[]; group: WidgetGroup<WidgetId> | null };

	// Deterministic key/id-order for a group, independent of the order its
	// cells happen to sit in the array — keeps floatPositions/DOM keys
	// stable across merges and re-derivations.
	function groupKey(group: WidgetGroup<WidgetId>): string {
		return group.cells
			.slice()
			.sort((a, b) => a.row - b.row || a.col - b.col)
			.map((c) => c.id)
			.join('+');
	}

	// Widgets merged into shared cards — persisted per-device (see
	// newtab-layout.ts), same as everything else in this section.
	let groups = $state<WidgetGroup<WidgetId>[]>([]);

	let widgetEls: Record<string, HTMLDivElement> = {};
	// Per-widget (not per-slot) element refs — a merged slot has one entry
	// per member so dock-zone detection can test against the specific
	// sub-widget's rect, not just the whole shared card.
	let cellEls: Record<string, HTMLDivElement> = {};
	function registerCellEl(node: HTMLDivElement, id: WidgetId) {
		cellEls[id] = node;
		return {
			destroy() {
				if (cellEls[id] === node) delete cellEls[id];
			}
		};
	}
	let floatPositions = $state<Record<string, FloatPosition>>({});
	// The specific sub-widget edge currently highlighted as a drop target —
	// replaces the old whole-card highlight now that docking is per-edge.
	let dragOverEdge = $state<{ cellId: WidgetId; edge: DockEdge } | null>(null);

	// Which card's kebab ("⋮") menu is open, if any — closed on an outside
	// click, same pattern as the search dropdown's blur handling above.
	let openMenuKey = $state<string | null>(null);
	$effect(() => {
		if (!openMenuKey) return;
		function onDocClick(e: MouseEvent) {
			if (!(e.target as HTMLElement).closest('[data-kebab-menu]')) openMenuKey = null;
		}
		document.addEventListener('click', onDocClick);
		return () => document.removeEventListener('click', onDocClick);
	});

	// Widgets hidden from the canvas entirely — kept as a Set of raw ids
	// (not slot keys), since the hide/show control on a merged card bundles
	// all its members together (see hideSlot below), and this lets an
	// individual member fall back to visible on its own if it's ever
	// unlinked from a group where only it was hidden.
	let hiddenIds = $state<Set<WidgetId>>(new Set());

	// Whether dragging (moving/merging) is enabled at all — toggled by the
	// Alt+L keybind below. Session-only (not persisted): each fresh tab
	// starts unlocked, since the point is a quick "stop me from bumping
	// things while I click around" switch, not a durable setting.
	let dragEnabled = $state(true);

	// One-time discoverability nudge for merging — the only other hint is a
	// tooltip on the tiny grip icon, easy to miss. Hidden once dismissed, or
	// automatically once the first merge actually happens (see mergeAtEdge).
	// showMergeHint/dismissMergeHint live further down, right after
	// isNarrowViewport is declared, since the hint doesn't apply there.
	let mergeHintDismissed = $state(true);

	// Deliberately reads only from localStorage helpers here, never from the
	// reactive $state vars this effect writes to (groups, floatPositions,
	// etc.) — reading one of those back after writing it, within the same
	// effect run, would make the effect depend on its own write and
	// re-trigger itself indefinitely (Svelte 5's effect_update_depth_exceeded).
	// Every value below is threaded through local variables instead.
	// A group loaded from storage is only valid if every cell id is a known
	// widget — guards against a stale/hand-edited localStorage value.
	function isValidGroup(g: StoredWidgetGroup): g is WidgetGroup<WidgetId> {
		return g.cells.every((c) => (WIDGET_IDS as readonly string[]).includes(c.id));
	}

	$effect(() => {
		const resolvedGroups = getWidgetGroups().filter(isValidGroup);
		groups = resolvedGroups;

		const seen = new Set<WidgetId>();
		const loadedSlots: Slot[] = [];
		for (const id of WIDGET_IDS) {
			if (seen.has(id)) continue;
			const group = resolvedGroups.find((g) => g.cells.some((c) => c.id === id)) ?? null;
			const ids = group ? group.cells.map((c) => c.id) : [id];
			ids.forEach((gid) => seen.add(gid));
			loadedSlots.push({ key: group ? groupKey(group) : id, ids, group });
		}

		const loadedFloat: Record<string, FloatPosition> = {};
		for (const slot of loadedSlots) {
			const pos = getFloatPosition(slot.key);
			if (pos) loadedFloat[slot.key] = pos;
		}
		floatPositions = loadedFloat;

		mergeHintDismissed = getMergeHintDismissed();

		hiddenIds = new Set(
			getHiddenWidgetIds().filter((id): id is WidgetId => (WIDGET_IDS as readonly string[]).includes(id))
		);
	});

	// All slots, unfiltered by visibility — the canonical source both the
	// canvas (which then filters per-slot) and the hidden-widgets tray
	// (which wants the opposite filter) build from. WIDGET_IDS order is
	// just a stable base for grouping/indexing — it has no visual meaning
	// once every card is independently positioned.
	const slots = $derived.by((): Slot[] => {
		const seen = new Set<WidgetId>();
		const result: Slot[] = [];
		for (const id of WIDGET_IDS) {
			if (seen.has(id)) continue;
			const group = groups.find((g) => g.cells.some((c) => c.id === id)) ?? null;
			const ids = group ? group.cells.map((c) => c.id) : [id];
			ids.forEach((gid) => seen.add(gid));
			result.push({ key: group ? groupKey(group) : id, ids, group });
		}
		return result;
	});

	// Cards default to a narrow width until dragged wider via the resize
	// handle (see startResize) — width lives on the same per-card position
	// record as x/y, rather than a separate "full width" grid-row concept
	// that doesn't mean anything on a freeform canvas.
	const CARD_WIDTH_NARROW = 260;
	const CARD_GAP = 16;
	// A never-measured card's assumed height, used only until its real
	// height is known (see measuredHeights below) — deliberately generous
	// so the very first layout pass doesn't undershoot and overlap.
	const CARD_HEIGHT_FALLBACK = 190;

	// Where the free-floating canvas starts, vertically — measured off the
	// actual centered header block (clock/search/nav/quick links) via
	// canvasAnchorEl below, rather than a hardcoded pixel guess, since the
	// header's height (and its centered position within the viewport)
	// varies with viewport height and content (e.g. whether quick links
	// exist at all).
	let canvasAnchorEl = $state<HTMLElement | undefined>();
	let canvasTop = $state(460);
	// Tracked reactively (not just read ad hoc) so anything that positions or
	// sizes a card — clampPosition, the narrow-viewport fallback below — stays
	// correct as the window resizes, not just at first render.
	let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280);
	let viewportHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 800);
	$effect(() => {
		if (!canvasAnchorEl) return;
		const el = canvasAnchorEl;
		function update() {
			canvasTop = el.getBoundingClientRect().bottom + 32;
			viewportWidth = window.innerWidth;
			viewportHeight = window.innerHeight;
		}
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		window.addEventListener('resize', update);
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', update);
		};
	});

	// Real rendered height per slot, kept in sync via a ResizeObserver (see
	// registerHeightObserver) so the default-position packer below can
	// place cards by their actual height instead of a fixed row height —
	// widgets render at very different heights (e.g. a 3-item notes list
	// vs. a single status line), so a fixed row spacing overlapped taller
	// cards with whatever landed in the row below them.
	let measuredHeights = $state<Record<string, number>>({});
	function registerHeightObserver(node: HTMLDivElement, key: string) {
		const ro = new ResizeObserver(([entry]) => {
			const height = entry.contentRect.height + 32; // + card padding
			if (measuredHeights[key] !== height) measuredHeights = { ...measuredHeights, [key]: height };
		});
		ro.observe(node);
		return {
			destroy() {
				ro.disconnect();
			}
		};
	}

	// Column-fill ("masonry") placement for every slot that hasn't been
	// explicitly dragged — each card goes into whichever column is
	// currently shortest, using its real measured height (or the fallback
	// for a card that hasn't rendered/measured yet), so cards pack tightly
	// without overlapping regardless of how tall any individual card is.
	const packedPositions = $derived.by((): Record<string, FloatPosition> => {
		const cols = Math.max(1, Math.floor((viewportWidth - CARD_GAP) / (CARD_WIDTH_NARROW + CARD_GAP)));
		const totalWidth = cols * CARD_WIDTH_NARROW + (cols - 1) * CARD_GAP;
		const startX = Math.max(CARD_GAP, (viewportWidth - totalWidth) / 2);
		const colBottoms = new Array(cols).fill(canvasTop);

		const result: Record<string, FloatPosition> = {};
		for (const slot of slots) {
			const col = colBottoms.indexOf(Math.min(...colBottoms));
			const y = colBottoms[col];
			result[slot.key] = { x: startX + col * (CARD_WIDTH_NARROW + CARD_GAP), y, width: CARD_WIDTH_NARROW };
			colBottoms[col] = y + (measuredHeights[slot.key] ?? CARD_HEIGHT_FALLBACK) + CARD_GAP;
		}
		return result;
	});

	function defaultPosition(key: string): FloatPosition {
		return packedPositions[key] ?? { x: CARD_GAP, y: canvasTop, width: CARD_WIDTH_NARROW };
	}

	const CARD_WIDTH_MIN = 200;
	const CARD_WIDTH_MAX = 720;

	// Pulls a position back within the current viewport without touching
	// what's actually saved — a card dragged near an edge (or one saved on a
	// wider window, then reopened on a narrower one) still renders fully
	// on-screen, but reverts to its real saved spot the moment the viewport
	// is wide enough again rather than being permanently rewritten here.
	function clampPosition(pos: FloatPosition, key?: string): FloatPosition {
		const width = Math.min(pos.width, Math.max(CARD_WIDTH_MIN, viewportWidth - CARD_GAP * 2));
		const maxX = Math.max(CARD_GAP, viewportWidth - width - CARD_GAP);
		// Keeps the card's bottom edge within the same CARD_GAP margin as the
		// other three sides, using its real measured height once known
		// (falling back to the same generous estimate the initial packing
		// pass uses for a not-yet-measured card — see measuredHeights above).
		const height = (key ? measuredHeights[key] : undefined) ?? CARD_HEIGHT_FALLBACK;
		const maxY = Math.max(CARD_GAP, viewportHeight - height - CARD_GAP);
		return {
			x: Math.min(Math.max(pos.x, CARD_GAP), maxX),
			y: Math.min(Math.max(pos.y, CARD_GAP), maxY),
			width
		};
	}

	// A slot's position right now — its live on-screen rect if mounted,
	// otherwise its algorithmic default — always clamped to the current
	// viewport. Used whenever a position needs to be captured/carried over
	// (merge, unlink, resize) rather than read from floatPositions directly,
	// since an untouched card has no entry there yet.
	function currentPositionFor(slot: Slot): FloatPosition {
		const saved = floatPositions[slot.key];
		if (saved) return clampPosition(saved, slot.key);
		const el = widgetEls[slot.key];
		if (el) {
			const rect = el.getBoundingClientRect();
			return clampPosition({ x: rect.left, y: rect.top, width: rect.width }, slot.key);
		}
		return clampPosition(defaultPosition(slot.key), slot.key);
	}

	// Resizing a merged card that has a "spanning" cell (one with a row of
	// other cells docked directly below it — e.g. a wide card over 2-3
	// narrower cards) also needs to update that cell's colSpan and repack
	// the row underneath into the new width — the one case the spec calls
	// out where sibling relayout is expected to happen automatically. Maps
	// the new pixel width to an approximate column count so a continuous
	// drag-resize still produces a sensible integer grid.
	function repackSpanningCellsFor(slot: Slot, width: number) {
		if (!slot.group) return;
		const group = slot.group;
		const belowRowFor = (cell: GroupCell<WidgetId>) =>
			group.cells.filter((c) => c.row === cell.row + cell.rowSpan && c.col >= cell.col && c.col < cell.col + cell.colSpan);
		const spanningCells = group.cells.filter((cell) => belowRowFor(cell).length > 0);
		if (!spanningCells.length) return;

		const approxCols = Math.max(1, Math.round((width + CARD_GAP) / (CARD_WIDTH_NARROW + CARD_GAP)));
		let nextGroup = group;
		for (const cell of spanningCells) {
			const belowCount = belowRowFor(cell).length;
			const newColSpan = Math.min(Math.max(1, approxCols), Math.max(belowCount, cell.colSpan));
			if (newColSpan !== cell.colSpan) nextGroup = repackRowUnderSpan(nextGroup, cell.id, newColSpan);
		}
		if (nextGroup !== group) {
			const nextGroups = [...groups.filter((g) => g !== group), nextGroup];
			groups = nextGroups;
			setWidgetGroups(nextGroups);
		}
	}

	// Free drag-resize via a handle on the card's bottom-right corner —
	// replaces the old binary narrow/wide toggle button. Mirrors startDrag's
	// pointer-tracking approach (window listeners, no capture needed).
	let activeResizeKey = $state<string | null>(null);

	function startResize(event: PointerEvent, slot: Slot) {
		if (!dragEnabled) return;
		event.preventDefault();
		event.stopPropagation();

		const origin = currentPositionFor(slot);
		activeResizeKey = slot.key;
		bringToFront(slot.key);
		const startX = event.clientX;

		function onMove(e: PointerEvent) {
			const width = Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, origin.width + (e.clientX - startX)));
			floatPositions = { ...floatPositions, [slot.key]: { ...origin, width } };
		}
		function onUp() {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			activeResizeKey = null;

			const final = floatPositions[slot.key];
			if (final) {
				setFloatPosition(slot.key, final);
				repackSpanningCellsFor(slot, final.width);
			}
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	// The intra-card grid gap (Tailwind `gap-2.5`) — needed alongside the
	// grid's own measured width to convert a column-divider drag's pixel
	// delta into a proportional `fr` delta.
	const GRID_GAP_PX = 10;
	const MIN_COL_FR_SHARE = 0.15;

	let gridEls: Record<string, HTMLDivElement> = {};
	// Column widths currently being live-dragged (see startColumnResize) —
	// kept separate from the persisted group.colFr so every other card's
	// render is untouched while one column divider is mid-drag.
	let resizingColFr = $state<{ slotKey: string; fr: number[] } | null>(null);

	// Drags the divider between column `colIndex - 1` and `colIndex` inside
	// a merged card, redistributing width between just that adjacent pair
	// (keeping their combined fr — and everyone else's — unchanged) rather
	// than resizing the whole card.
	function startColumnResize(event: PointerEvent, slot: Slot, colIndex: number) {
		if (!dragEnabled || !slot.group) return;
		event.preventDefault();
		event.stopPropagation();

		const group = slot.group;
		const dims = gridDimensions(group);
		const startFr = resolveColFr(group, dims.cols).slice();
		const gridRect = gridEls[slot.key]?.getBoundingClientRect();
		if (!gridRect) return;

		const availablePx = gridRect.width - GRID_GAP_PX * (dims.cols - 1);
		const frTotal = startFr.reduce((a, b) => a + b, 0);
		const pairTotal = startFr[colIndex - 1] + startFr[colIndex];
		const minFr = frTotal * MIN_COL_FR_SHARE;
		const startX = event.clientX;

		function onMove(e: PointerEvent) {
			const deltaFr = ((e.clientX - startX) / availablePx) * frTotal;
			let left = startFr[colIndex - 1] + deltaFr;
			let right = pairTotal - left;
			if (left < minFr) {
				left = minFr;
				right = pairTotal - minFr;
			} else if (right < minFr) {
				right = minFr;
				left = pairTotal - minFr;
			}
			const next = startFr.slice();
			next[colIndex - 1] = left;
			next[colIndex] = right;
			resizingColFr = { slotKey: slot.key, fr: next };
		}
		function onUp() {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);

			if (resizingColFr && resizingColFr.slotKey === slot.key) {
				const nextGroup = setColFr(group, resizingColFr.fr);
				const nextGroups = [...groups.filter((g) => g !== group), nextGroup];
				groups = nextGroups;
				setWidgetGroups(nextGroups);
			}
			resizingColFr = null;
		}
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
	}

	// Hiding/showing a slot bundles all its member ids together — there's
	// only one hide control on a merged card's shared header.
	function hideSlot(slot: Slot) {
		const next = new Set(hiddenIds);
		slot.ids.forEach((id) => next.add(id));
		hiddenIds = next;
		setHiddenWidgetIds([...next]);
	}

	function unhideSlot(slot: Slot) {
		const next = new Set(hiddenIds);
		slot.ids.forEach((id) => next.delete(id));
		hiddenIds = next;
		setHiddenWidgetIds([...next]);
	}

	// Pulls one widget back out of a merged card into its own standalone
	// card, landing just offset from where the merged card was (so it's
	// visible as a separate card rather than exactly overlapping). The
	// remainder keeps the merged card's old spot and old grid — the
	// vacated cell just stays empty rather than the remaining cells
	// re-stretching to fill it (matches the spec's unlink behavior).
	function unlinkWidget(id: WidgetId) {
		const group = groups.find((g) => g.cells.some((c) => c.id === id));
		if (!group) return;
		const mergedSlot = slots.find((s) => s.ids.includes(id));
		const basePos = mergedSlot ? currentPositionFor(mergedSlot) : defaultPosition(id);
		const oldKey = mergedSlot?.key;

		const remaining = removeCell(group, id);
		const nextGroups = groups.filter((g) => g !== group);
		if (remaining.cells.length > 1) nextGroups.push(remaining);
		groups = nextGroups;
		setWidgetGroups(nextGroups);

		const nextFloat = { ...floatPositions };
		if (oldKey) {
			delete nextFloat[oldKey];
			clearFloatPosition(oldKey);
		}

		const unlinkedPos: FloatPosition = { x: basePos.x + 24, y: basePos.y + 24, width: CARD_WIDTH_NARROW };
		nextFloat[id] = unlinkedPos;
		setFloatPosition(id, unlinkedPos);

		const remainderKey = remaining.cells.length > 1 ? groupKey(remaining) : remaining.cells[0]?.id;
		if (remainderKey) {
			nextFloat[remainderKey] = basePos;
			setFloatPosition(remainderKey, basePos);
		}

		floatPositions = nextFloat;
	}

	// Docks the dragged slot onto a specific edge of a specific cell inside
	// the target slot — this is the grid-aware replacement for the old
	// "drop anywhere on the target card" merge. Any prior group membership
	// for the dragged slot's ids is dissolved first, so docking a widget
	// that was already linked elsewhere moves it rather than doubling it up.
	// A multi-widget source (itself already a merged card) has each of its
	// ids inserted at the same edge in turn, so the whole card comes along.
	function mergeAtEdge(source: Slot, targetCellId: WidgetId, edge: DockEdge) {
		const targetSlot = slots.find((s) => s.ids.includes(targetCellId));
		if (!targetSlot || targetSlot.key === source.key) return;
		const targetPos = currentPositionFor(targetSlot);

		if (!mergeHintDismissed) dismissMergeHint();

		const involved = new Set(source.ids);
		const remainingGroups = groups.filter((g) => !g.cells.some((c) => involved.has(c.id)) && g !== targetSlot.group);

		let nextGroup: WidgetGroup<WidgetId> =
			targetSlot.group ?? { cells: [{ id: targetCellId, row: 0, col: 0, rowSpan: 1, colSpan: 1 }] };
		for (const id of source.ids) {
			nextGroup = insertCell(nextGroup, targetCellId, edge, id);
		}

		const nextGroups = [...remainingGroups, nextGroup];
		groups = nextGroups;
		setWidgetGroups(nextGroups);

		// A merged card needs roughly one narrow column's worth of width per
		// column in the resulting grid — reusing the target's old width
		// would cram a wide row into a sliver.
		const dims = gridDimensions(nextGroup);
		const mergedWidth = dims.cols * CARD_WIDTH_NARROW + (dims.cols - 1) * CARD_GAP;
		const mergedPos: FloatPosition = { ...targetPos, width: Math.max(targetPos.width, mergedWidth) };

		const mergedKey = groupKey(nextGroup);
		const nextFloat = { ...floatPositions };
		delete nextFloat[source.key];
		delete nextFloat[targetSlot.key];
		nextFloat[mergedKey] = mergedPos;
		floatPositions = nextFloat;
		clearFloatPosition(source.key);
		clearFloatPosition(targetSlot.key);
		setFloatPosition(mergedKey, mergedPos);
	}

	// Stacking order for overlapping cards — most-recently-interacted-with
	// last (topmost). Session-only, same as dragEnabled: which card happens
	// to be on top is a transient viewing preference, not worth persisting.
	let zOrder = $state<string[]>([]);
	function bringToFront(key: string) {
		if (zOrder[zOrder.length - 1] === key) return;
		zOrder = [...zOrder.filter((k) => k !== key), key];
	}
	function zIndexFor(key: string): number {
		const index = zOrder.indexOf(key);
		return 10 + (index === -1 ? 0 : index + 1);
	}

	// Single pointer-based gesture drives both freeform positioning and
	// merging — native HTML5 drag-and-drop (the previous approach)
	// unreliably lost the drag whenever it started over a link, button, or
	// text input inside a widget (the browser hijacks it into a link/text
	// drag instead). Grabbing the grip now always works the same way
	// regardless of what's under the cursor: the card follows the pointer
	// (activeDragKey drives the "lifted" look below); release it over
	// another card to merge the two into one combined card; release
	// anywhere else and it just stays at the drop point.
	let activeDragKey = $state<string | null>(null);

	// document.elementFromPoint would otherwise always hit the dragged card
	// itself (it's rendered right under the cursor) — hiding it from
	// hit-testing for the duration of the lookup reveals whatever's beneath.
	// Resolves down to the specific sub-widget cell (not just the shared
	// container) so dock-zone detection can test against that cell's own
	// edges — the same cell can be tested whether it's a standalone card or
	// one member of an already-merged one.
	function dockTargetUnderPoint(
		x: number,
		y: number,
		excludeKey: string
	): { cellId: WidgetId; edge: DockEdge } | null {
		const excludeEl = widgetEls[excludeKey];
		const prevPointerEvents = excludeEl?.style.pointerEvents;
		if (excludeEl) excludeEl.style.pointerEvents = 'none';
		const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-cell-id]');
		if (excludeEl) excludeEl.style.pointerEvents = prevPointerEvents ?? '';

		const cellId = hit?.dataset.cellId as WidgetId | undefined;
		if (!cellId || slots.find((s) => s.ids.includes(cellId))?.key === excludeKey) return null;

		const rect = (cellEls[cellId] ?? hit)?.getBoundingClientRect();
		if (!rect) return null;
		const edge = edgeDockTarget(rect, x, y);
		return edge ? { cellId, edge } : null;
	}

	// Pointer/touch tracking itself is handled by @dnd-kit/svelte's
	// DragDropProvider + createDraggable (see the grip handle's
	// draggable.attachHandle in the template) — replaces the old hand-rolled
	// window pointermove/pointerup listeners. Everything domain-specific
	// (dock-edge detection, merging, z-order, position persistence) is
	// unchanged, just fed from dnd-kit's drag events instead of raw
	// PointerEvents.
	//
	// The live visual drag (the card following the pointer) is left entirely
	// to dnd-kit's own default "feedback" behavior, which applies a CSS
	// transform to the dragged element for the duration of the gesture —
	// floatPositions is deliberately NOT updated on every dragmove. Doing
	// both at once (our own left/top *and* dnd-kit's transform, both
	// independently tracking the pointer) stacks and sends the card flying
	// off far from the cursor. dragmove is only used to keep dragOverEdge
	// current for the dock-zone highlight; the actual resting position is
	// computed once, from the cumulative transform, when the drag ends —
	// dragOrigin is a plain (non-reactive) var, only ever read/written by
	// these three handlers in sequence for a single in-flight drag, so it
	// doesn't need to be $state.
	let dragOrigin: FloatPosition | null = null;

	function slotForDragId(id: string | number | undefined | null): Slot | undefined {
		if (id == null) return undefined;
		return slots.find((s) => s.key === id);
	}

	function handleDragStart(event: { operation: { source: { id: string | number } | null } }) {
		const slot = slotForDragId(event.operation.source?.id);
		if (!slot) return;

		dragOrigin = currentPositionFor(slot);
		activeDragKey = slot.key;
		bringToFront(slot.key);
	}

	function handleDragMove(event: {
		operation: { source: { id: string | number } | null; position: { current: { x: number; y: number } } };
	}) {
		const slot = slotForDragId(event.operation.source?.id);
		if (!slot || !dragOrigin) return;

		const pos = event.operation.position.current;
		dragOverEdge = dockTargetUnderPoint(pos.x, pos.y, slot.key);
	}

	function handleDragEnd(event: {
		operation: { source: { id: string | number } | null; transform: { x: number; y: number } };
		canceled: boolean;
	}) {
		const slot = slotForDragId(event.operation.source?.id);
		const target = dragOverEdge;
		const origin = dragOrigin;
		activeDragKey = null;
		dragOverEdge = null;
		dragOrigin = null;
		if (!slot || !origin || event.canceled) return;

		const { x, y } = event.operation.transform;
		const final: FloatPosition = { x: origin.x + x, y: origin.y + y, width: origin.width };
		floatPositions = { ...floatPositions, [slot.key]: final };

		if (target) {
			mergeAtEdge(slot, target.cellId, target.edge);
		} else {
			setFloatPosition(slot.key, final);
		}
	}

	// Double-clicking a grip handle resets that card back to its
	// algorithmic default position/width — a quick escape hatch alongside
	// dragging it back manually (also cleared in bulk by "Reset layout").
	function resetSlotPosition(slot: Slot) {
		const next = { ...floatPositions };
		delete next[slot.key];
		floatPositions = next;
		clearFloatPosition(slot.key);
	}

	function resetLayout() {
		resetAllFloatPositions();
		resetHiddenWidgets();
		resetWidgetGroups();
		floatPositions = {};
		hiddenIds = new Set();
		groups = [];
	}

	// Below this width, dragging/resizing/docking a pixel-positioned canvas
	// doesn't really work on a touch screen — fall back to a plain stacked
	// list in normal document flow instead (see the template's wrapper div
	// and widgetStyle/widgetClass below).
	const NARROW_BREAKPOINT = 640;
	const isNarrowViewport = $derived(viewportWidth < NARROW_BREAKPOINT);

	const showMergeHint = $derived(!mergeHintDismissed && groups.length === 0 && !isNarrowViewport);
	function dismissMergeHint() {
		mergeHintDismissed = true;
		setMergeHintDismissed();
	}

	function widgetClass(slot: Slot): string {
		const lifted = activeDragKey === slot.key || activeResizeKey === slot.key ? ' scale-105 opacity-90' : '';
		return `glass floating-widget rounded-2xl p-4${lifted}`;
	}

	function widgetStyle(slot: Slot): string {
		const lifted = activeDragKey === slot.key || activeResizeKey === slot.key;
		if (isNarrowViewport) return `width:100%; z-index:${lifted ? 20 : 1};`;
		const pos = currentPositionFor(slot);
		return `position:fixed; left:${pos.x}px; top:${pos.y}px; width:${pos.width}px; z-index:${lifted ? 1000 : zIndexFor(slot.key)}; pointer-events:${activeDragKey === slot.key ? 'none' : 'auto'};`;
	}
</script>

<svelte:head>
	<title>New Tab</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if currentPhoto}
	<div class="photo-bg" aria-hidden="true" style:background-image="url({currentPhoto.url})"></div>
	<div class="photo-bg-scrim" aria-hidden="true"></div>
	<div class="glass fixed right-4 bottom-4 z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-white/70">
		Photo by
		<a
			href={currentPhoto.photographerProfileUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="text-white/90 hover:text-primary"
		>
			{currentPhoto.photographerName}
		</a>
		on
		<a
			href={currentPhoto.photoPageUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="text-white/90 hover:text-primary"
		>
			Unsplash
		</a>
		{#if data.photoHistory.length > 1}
			<form
				method="POST"
				action="?/cyclePhoto"
				use:enhance={() => {
					return async ({ result }) => {
						if (result.type === 'success' && result.data?.photo) {
							currentPhoto = result.data.photo as typeof currentPhoto;
							favoritedOverride = null;
						}
					};
				}}
			>
				<input type="hidden" name="currentUrl" value={currentPhoto.url} />
				<button type="submit" aria-label="Shuffle background" class="text-white/60 hover:text-primary">
					<Shuffle size={13} aria-hidden="true" />
				</button>
			</form>
		{/if}
		{#if currentPhotoId}
			<button
				type="button"
				onclick={toggleFavoritePhoto}
				aria-label={currentPhotoFavorited ? 'Unfavorite this background' : 'Favorite this background'}
				class="hover:text-primary {currentPhotoFavorited ? 'text-primary' : 'text-white/60'}"
			>
				<Star size={13} aria-hidden="true" fill={currentPhotoFavorited ? 'currentColor' : 'none'} />
			</button>
		{/if}
	</div>
{:else}
	<div class="aurora" aria-hidden="true">
		<span class="aurora-blob aurora-blob--1"></span>
		<span class="aurora-blob aurora-blob--2"></span>
		<span class="aurora-blob aurora-blob--3"></span>
	</div>
{/if}

<div class="fixed top-4 right-4 z-20 flex gap-2">
	{#if !dragEnabled}
		<button
			type="button"
			onclick={() => (dragEnabled = true)}
			title="Widget dragging is locked — click or press Alt+L to unlock"
			aria-label="Unlock widget dragging"
			class="glass glass--interactive grid h-9 w-9 place-items-center rounded-full text-primary"
		>
			<Lock size={16} aria-hidden="true" />
		</button>
	{/if}
	{#if Object.keys(floatPositions).length || hiddenIds.size || groups.length}
		<button
			type="button"
			onclick={resetLayout}
			aria-label="Reset widget layout"
			class="glass glass--interactive grid h-9 w-9 place-items-center rounded-full text-white/70 hover:text-primary"
		>
			<LayoutGrid size={16} aria-hidden="true" />
		</button>
	{/if}
	<button
		type="button"
		onclick={() => (quickLinksOpen = !quickLinksOpen)}
		aria-label="Edit quick links"
		class="glass glass--interactive grid h-9 w-9 place-items-center rounded-full text-white/70 hover:text-primary"
	>
		<Plus size={16} aria-hidden="true" />
	</button>
	<button
		type="button"
		onclick={() => (settingsOpen = !settingsOpen)}
		aria-label="Dashboard settings"
		class="glass glass--interactive grid h-9 w-9 place-items-center rounded-full text-white/70 hover:text-primary"
	>
		<Settings size={16} aria-hidden="true" />
	</button>
</div>

{#if settingsOpen}
	<div class="glass fixed top-16 right-4 z-20 w-72 rounded-2xl p-4">
		<div class="flex items-center justify-between">
			<h2 class="text-xs font-medium tracking-wide text-white/50 uppercase">Dashboard settings</h2>
			<button
				type="button"
				onclick={() => (settingsOpen = false)}
				aria-label="Close"
				class="text-white/50 hover:text-primary"
			>
				<X size={14} aria-hidden="true" />
			</button>
		</div>

		{#if data.unsplashConfigured}
			<form
				method="POST"
				action="?/updateBackground"
				class="mt-3"
				use:enhance={() => {
					return async ({ update }) => {
						await update();
						settingsOpen = false;
					};
				}}
			>
				<label class="block text-xs text-white/50" for="unsplash-query">Photo search terms</label>
				<input
					id="unsplash-query"
					name="query"
					type="text"
					bind:value={queryInput}
					placeholder="cinematic mountains"
					class="glass mt-1.5 w-full rounded-lg px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-primary/60"
				/>
				<button
					type="submit"
					class="mt-3 w-full rounded-lg bg-primary/90 py-2 text-sm font-medium text-black transition-colors hover:bg-primary"
				>
					Save
				</button>
			</form>
		{/if}

		<form
			method="POST"
			action="?/updateIcsUrl"
			class="mt-3 {data.unsplashConfigured ? 'border-t border-white/10 pt-3' : ''}"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					settingsOpen = false;
				};
			}}
		>
			<label class="block text-xs text-white/50" for="ics-url">Calendar feed (.ics URL)</label>
			<input
				id="ics-url"
				name="icsUrl"
				type="text"
				bind:value={icsUrlInput}
				placeholder="https://calendar.google.com/…/basic.ics"
				class="glass mt-1.5 w-full rounded-lg px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-primary/60"
			/>
			<button
				type="submit"
				class="mt-3 w-full rounded-lg bg-primary/90 py-2 text-sm font-medium text-black transition-colors hover:bg-primary"
			>
				Save
			</button>
		</form>

		{#if favoritedPhotos.length}
			<div class="mt-4 border-t border-white/10 pt-3">
				<h3 class="text-xs font-medium tracking-wide text-white/50 uppercase">Favorites</h3>
				<div class="mt-2 grid grid-cols-4 gap-1.5">
					{#each favoritedPhotos as photo (photo.id)}
						<form
							method="POST"
							action="?/selectPhoto"
							use:enhance={() => {
								return async ({ result }) => {
									if (result.type === 'success' && result.data?.photo) {
										currentPhoto = result.data.photo as typeof currentPhoto;
										favoritedOverride = null;
									}
								};
							}}
						>
							<input type="hidden" name="id" value={photo.id} />
							<button
								type="submit"
								title="Use this photo as the background"
								aria-label="Use photo by {photo.photographerName} as background"
								class="aspect-square w-full overflow-hidden rounded-lg border transition-colors {currentPhoto?.url ===
								photo.url
									? 'border-primary'
									: 'border-white/10 hover:border-primary/50'}"
							>
								<img src={photo.url} alt="" class="h-full w-full object-cover" />
							</button>
						</form>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<QuickLinksModal bind:open={quickLinksOpen} quickLinks={data.quickLinks} bind:sortByClicks />

<main class="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-6">
	<div class="text-center">
		<p class="text-6xl font-bold tracking-tight text-white tabular-nums">{timeString}</p>
		<p class="mt-2 text-lg text-white/80">{greeting}.</p>
	</div>

	<form class="relative mx-auto mt-6 w-full max-w-lg" onsubmit={submitSearch}>
		<label class="relative block">
			<input
				bind:this={searchInputEl}
				type="search"
				bind:value={query}
				autofocus
				onfocus={() => (searchFocused = true)}
				onblur={handleSearchBlur}
				onkeydown={handleSearchKeydown}
				placeholder="Search or paste a link… (try ! for bangs)"
				class="glass w-full rounded-full py-3 pr-4 pl-10 text-sm text-white placeholder-white/40 outline-none focus:border-primary/60"
			/>
			<Search
				size={16}
				aria-hidden="true"
				class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-white/50"
			/>
		</label>

		{#if dropdownOpen}
			<ul class="glass absolute inset-x-0 top-full z-30 mt-2 max-h-72 overflow-y-auto rounded-2xl p-1.5">
				{#each suggestions as suggestion, i (suggestion.kind === 'search'
					? `s:${suggestion.value}`
					: suggestion.kind === 'link'
						? `l:${suggestion.id}`
						: suggestion.kind === 'calc'
							? `c:${suggestion.expression}`
							: `b:${suggestion.trigger}`)}
					<li class="flex items-center">
						<button
							type="button"
							onmousedown={(e) => e.preventDefault()}
							onclick={() => chooseSuggestion(suggestion)}
							class="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors {i ===
							selectedIndex
								? 'bg-primary/15 text-primary'
								: 'text-white/80 hover:bg-white/5'}"
						>
							{#if suggestion.kind === 'search'}
								<Search size={13} aria-hidden="true" class="flex-shrink-0 text-white/40" />
								<span class="truncate">{suggestion.value}</span>
							{:else if suggestion.kind === 'link'}
								<Link2 size={13} aria-hidden="true" class="flex-shrink-0 text-white/40" />
								<span class="truncate">{suggestion.label}</span>
								<span class="ml-auto flex-shrink-0 text-[10px] tracking-wide text-white/35 uppercase">Quick link</span>
							{:else if suggestion.kind === 'calc'}
								<span class="truncate font-medium">{suggestion.expression} = {formatCalcValue(suggestion.value)}</span>
								<span class="ml-auto flex-shrink-0 text-[10px] tracking-wide text-white/35 uppercase">
									{calcCopied && i === selectedIndex ? 'Copied ✓' : 'Copy'}
								</span>
							{:else}
								<span
									class="flex-shrink-0 rounded border border-white/15 px-1 text-[10px] tracking-wide text-white/50 uppercase"
								>
									{suggestion.trigger}
								</span>
								<span class="truncate">{suggestion.label}</span>
							{/if}
						</button>
						{#if suggestion.kind === 'search'}
							<button
								type="button"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => removeSearchSuggestion(suggestion.value)}
								aria-label="Remove '{suggestion.value}' from recent searches"
								class="flex-shrink-0 px-2 py-2 text-white/30 hover:text-primary"
							>
								<X size={12} aria-hidden="true" />
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</form>

	<nav class="mx-auto mt-6 flex flex-wrap justify-center gap-2">
		{#each dashboardLinks as link}
			{@const Icon = linkIcons[link.label as keyof typeof linkIcons]}
			<a
				href={link.href}
				class="glass glass--interactive flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/80 transition-colors hover:text-primary"
			>
				{#if Icon}
					<Icon size={15} aria-hidden="true" />
				{/if}
				{link.label}
			</a>
		{/each}
	</nav>

	{#if data.quickLinks.length}
		<p class="mx-auto mt-5 text-center text-[10px] font-medium tracking-wide text-white/35 uppercase">
			Quick links
		</p>
		<div class="mx-auto mt-2 flex flex-wrap justify-center gap-2">
			{#each displayedQuickLinks as link (link.id)}
				<a
					href={link.url}
					onclick={() => trackQuickLinkClick(link.id)}
					class="glass glass--interactive flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-white/70 transition-colors hover:text-primary"
				>
					{#if link.icon}
						<QuickLinkIcon icon={link.icon} size={14} />
					{:else if faviconFor(link.url)}
						<img src={faviconFor(link.url)} alt="" class="h-3.5 w-3.5 rounded-sm" />
					{/if}
					{link.label}
					{#if link.shortcut}
						<span class="rounded border border-white/15 px-1 text-[9px] tracking-wide text-white/40 uppercase">
							{link.shortcut}
						</span>
					{/if}
				</a>
			{/each}
		</div>
	{/if}

	{#if showMergeHint}
		<div
			class="glass mx-auto mt-4 flex w-fit max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-xs text-white/70"
		>
			<Link2 size={12} aria-hidden="true" class="flex-shrink-0 text-primary" />
			<span>Drag a card onto another's edge to dock them together.</span>
			<button
				type="button"
				onclick={dismissMergeHint}
				aria-label="Dismiss tip"
				class="flex-shrink-0 text-white/40 hover:text-primary"
			>
				<X size={11} aria-hidden="true" />
			</button>
		</div>
	{/if}

	<!-- Marks where the centered header block actually ends, so the
	     floating-card canvas can start below it regardless of viewport
	     height/content (see canvasAnchorEl / canvasTop above). -->
	<div bind:this={canvasAnchorEl} aria-hidden="true"></div>

	{#snippet widgetBody(id: WidgetId)}
		{#if id === 'right-now'}
			<ul class="grid gap-1">
				{#each data.statusItems as item}
					<li class="text-sm text-white/80">{item}</li>
				{/each}
			</ul>
		{:else if id === 'now-playing'}
			<ListeningNowCard bare>
				{#snippet fallback()}
					<p class="text-sm text-white/60">Nothing playing right now.</p>
				{/snippet}
			</ListeningNowCard>
		{:else if id === 'discord'}
			<DiscordPresence activityOnly />
		{:else if id === 'recent-notes'}
			{#if data.recentNotes.length}
				<ul class="grid gap-1.5">
					{#each data.recentNotes as note}
						<li>
							<a href="/notes/{note.id}" class="group flex items-center gap-2 text-sm text-white/80 hover:text-primary">
								<span
									class="grid h-6 w-6 flex-shrink-0 place-items-center rounded bg-white/5 text-white/40 group-hover:text-primary"
								>
									<ScrollText size={12} aria-hidden="true" />
								</span>
								<span class="truncate">{note.title}</span>
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-white/60">No notes yet.</p>
			{/if}
		{:else if id === 'watching'}
			<ul class="grid gap-2">
				{#each data.watching.slice(0, 2) as item}
					<li>
						<a href={item.href} target="_blank" rel="noopener noreferrer" class="group flex items-center gap-2">
							{#if item.posterUrl}
								<img src={item.posterUrl} alt="" class="h-9 w-6 flex-shrink-0 rounded object-cover" />
							{/if}
							<span class="min-w-0">
								<span class="block truncate text-sm text-white/80 group-hover:text-primary">{item.title}</span>
								{#if item.nextToWatch}
									<span class="block text-xs text-white/60">Next: {item.nextToWatch}</span>
								{/if}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else if id === 'weather'}
			{#if weather === null}
				<p class="text-sm text-white/60">Checking…</p>
			{:else if weather === 'denied'}
				<p class="text-sm text-white/60">Location access denied.</p>
			{:else if weather === 'timeout' || weather === 'unavailable' || weather === 'error'}
				<p class="text-sm text-white/60">
					{weather === 'timeout' ? 'Location lookup timed out.' : 'Weather unavailable.'}
				</p>
				<button type="button" onclick={loadWeather} class="mt-1.5 text-xs text-white/60 underline hover:text-primary">
					Retry
				</button>
			{:else}
				<p class="text-xl font-semibold text-white">{weather.tempC}°C</p>
				<p class="text-sm text-white/60">{weatherLabel(weather.code)}</p>
			{/if}
		{:else if id === 'focus'}
			<p class="text-xl font-semibold text-white tabular-nums">{pomodoroTimeString}</p>
			<p class="text-xs text-white/60">
				{pomodoroOnBreak ? 'Break' : 'Focus'} · {data.focusStats.sessionsToday} session{data.focusStats
					.sessionsToday === 1
					? ''
					: 's'} today
			</p>
			<div class="mt-2 flex gap-2">
				<button
					type="button"
					onclick={togglePomodoro}
					class="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/80 transition-colors hover:border-primary/50 hover:text-primary"
				>
					{pomodoroRunning ? 'Pause' : 'Start'}
				</button>
				<button
					type="button"
					onclick={resetPomodoro}
					class="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/80 transition-colors hover:border-primary/50 hover:text-primary"
				>
					Reset
				</button>
			</div>
			<div class="mt-2.5 flex items-end gap-1" title="Focus minutes, last 7 days">
				{#each data.focusWeekly.days as day (day.date)}
					{@const height = Math.min(24, 4 + day.minutes / 4)}
					<div
						class="w-2.5 rounded-sm {day.minutes > 0 ? 'bg-primary/70' : 'bg-white/10'}"
						style="height: {height}px;"
						title="{day.date}: {day.minutes} min"
					></div>
				{/each}
				{#if data.focusWeekly.streak > 1}
					<span class="ml-1.5 text-xs text-white/60">🔥 {data.focusWeekly.streak}-day streak</span>
				{/if}
			</div>
		{:else if id === 'todo'}
			{#if displayedTodoItems.length}
				<ul class="grid gap-1.5">
					{#each displayedTodoItems as item (item.id)}
						<li class="flex items-center gap-2">
							<form method="POST" action="?/toggleTodo" use:enhance>
								<input type="hidden" name="id" value={item.id} />
								<button
									type="submit"
									role="checkbox"
									aria-checked={item.done}
									aria-label={item.done ? 'Mark incomplete' : 'Mark complete'}
									class="grid h-4 w-4 flex-shrink-0 place-items-center rounded border {item.done
										? 'border-primary bg-primary/80'
										: 'border-white/30'}"
								></button>
							</form>
							<span
								class="min-w-0 flex-1 truncate text-sm {item.done ? 'text-white/40 line-through' : 'text-white/80'}"
							>
								{item.body}
							</span>
							<form method="POST" action="?/removeTodo" use:enhance>
								<input type="hidden" name="id" value={item.id} />
								<button type="submit" aria-label="Remove to-do" class="flex-shrink-0 text-white/30 hover:text-primary">
									<Trash2 size={12} aria-hidden="true" />
								</button>
							</form>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-white/60">Nothing to do.</p>
			{/if}
			<form
				method="POST"
				action="?/addTodo"
				class="mt-2 flex items-center gap-2"
				use:enhance={() => {
					return async ({ update }) => {
						await update({ reset: false });
						todoBody = '';
					};
				}}
			>
				<input
					name="body"
					type="text"
					bind:value={todoBody}
					placeholder="Add a to-do…"
					class="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/40 outline-none focus:border-primary/60"
				/>
				<button
					type="submit"
					class="flex-shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 transition-colors hover:border-primary/50 hover:text-primary"
				>
					Add
				</button>
			</form>
		{:else if id === 'agenda'}
			<ul class="grid gap-1.5">
				{#each data.agenda as event}
					<li class="text-sm text-white/80">
						<span class="text-white/50">{agendaLabel(event.start, event.allDay)}</span>
						— {event.summary}
					</li>
				{/each}
			</ul>
		{:else if id === 'note'}
			<form
				method="POST"
				action="?/quickNote"
				class="flex items-center gap-2"
				use:enhance={() => {
					return async ({ update, result }) => {
						await update({ reset: false });
						if (result.type === 'success') {
							noteBody = '';
							noteSaved = true;
							setTimeout(() => (noteSaved = false), 2000);
						}
					};
				}}
			>
				<input
					name="body"
					type="text"
					bind:value={noteBody}
					placeholder="Jot a quick note…"
					class="glass min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/40 outline-none focus:border-primary/60"
				/>
				<button
					type="submit"
					class="flex-shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 transition-colors hover:border-primary/50 hover:text-primary"
				>
					{noteSaved ? 'Saved ✓' : 'Save'}
				</button>
			</form>
		{/if}
	{/snippet}

	<!-- On a wide viewport every card is position:fixed via widgetStyle, so
	     this wrapper isn't a layout container there — it's just where they
	     live in the markup, and main's own content (clock/search/nav/quick
	     links) stays the only thing that affects main's flow height, keeping
	     that header block centered regardless of how many cards are
	     floating. Below NARROW_BREAKPOINT, dragging a pixel-positioned
	     canvas doesn't work well on a touch screen, so widgetStyle instead
	     returns normal-flow sizing and this wrapper becomes a real stacked
	     list (see isNarrowViewport above). -->
	<DragDropProvider onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd}>
	<div class={isNarrowViewport ? 'mx-auto mt-6 flex w-full max-w-md flex-col gap-3' : ''}>
		{#each slots as slot (slot.key)}
			{@const visibleIds = slot.ids.filter(widgetVisible)}
			{#if visibleIds.length}
				{@const cardLabel = visibleIds.map((id) => WIDGET_META[id].label).join(' + ')}
				{@const draggable = createDraggable({
					id: slot.key,
					disabled: !dragEnabled || isNarrowViewport,
					// We commit the card's real resting position to floatPositions
					// the instant the drag ends (see handleDragEnd) — dnd-kit's
					// own default "drop animation" then tries to separately
					// animate its CSS transform back to zero relative to the
					// element's *old* left/top, fighting our instant jump to the
					// new left/top and producing a fly-off/pop-in glitch. Disable
					// just that animation; the live drag-follow feedback itself
					// (which this doesn't touch) is what makes the card track the
					// pointer during the gesture.
					plugins: [Feedback.configure({ dropAnimation: null })]
				})}
				<div
					bind:this={widgetEls[slot.key]}
					use:registerHeightObserver={slot.key}
					{@attach draggable.attach}
					onpointerdown={() => bringToFront(slot.key)}
					data-slot-key={slot.key}
					class={widgetClass(slot)}
					style={widgetStyle(slot)}
					role="group"
					aria-label="{cardLabel} widget"
				>
				<div class="flex items-center justify-between gap-2">
					<h2 class="flex items-center gap-1.5 text-xs font-medium tracking-wide text-white/60 uppercase">
						{#if visibleIds.length === 1}
							{@const soloId = visibleIds[0]}
							{@const SoloIcon = WIDGET_META[soloId].icon}
							{#if SoloIcon}
								<SoloIcon size={13} aria-hidden="true" />
							{/if}
							{cardLabel}
							{#if soloId === 'now-playing' || soloId === 'discord'}
								<span class="relative flex h-1.5 w-1.5" title="Live" aria-hidden="true">
									<span class="absolute h-full w-full animate-ping rounded-full bg-primary opacity-75"></span>
									<span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
								</span>
							{/if}
						{:else}
							<Link2 size={12} aria-hidden="true" class="text-white/30" />
						{/if}
					</h2>
					<div class="flex items-center gap-1.5">
						{#if isNarrowViewport}
							<!-- No drag/reorder affordance below the narrow breakpoint —
							     see isNarrowViewport above. -->
						{:else if dragEnabled}
							<button
								type="button"
								class="cursor-grab touch-none text-white/30 hover:text-primary active:cursor-grabbing"
								{@attach draggable.attachHandle}
								ondblclick={() => resetSlotPosition(slot)}
								title="Drag anywhere to move, or onto another card's edge to dock them together. Double-click to reset position."
								aria-label="Move {cardLabel} widget"
							>
									<GripVertical size={12} aria-hidden="true" />
								</button>
							{:else}
								<span
									class="text-white/15"
									title="Dragging locked — press Alt+L (or the lock icon, top right) to unlock"
								>
									<Lock size={12} aria-hidden="true" />
								</span>
							{/if}
							<div class="relative" data-kebab-menu>
								<button
									type="button"
									onclick={() => (openMenuKey = openMenuKey === slot.key ? null : slot.key)}
									title="More options"
									aria-label="More options for {cardLabel} widget"
									aria-haspopup="true"
									aria-expanded={openMenuKey === slot.key}
									class="text-white/30 hover:text-primary"
								>
									<MoreVertical size={12} aria-hidden="true" />
								</button>
								{#if openMenuKey === slot.key}
									<div class="glass absolute top-full right-0 z-30 mt-1 w-36 rounded-lg p-1">
										<button
											type="button"
											onclick={() => {
												hideSlot(slot);
												openMenuKey = null;
											}}
											class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-white/70 hover:bg-white/10 hover:text-primary"
										>
											<EyeOff size={11} aria-hidden="true" /> Hide
										</button>
										<button
											type="button"
											onclick={() => {
												resetSlotPosition(slot);
												openMenuKey = null;
											}}
											class="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs text-white/70 hover:bg-white/10 hover:text-primary"
										>
											<RotateCcw size={11} aria-hidden="true" /> Reset position
										</button>
									</div>
								{/if}
							</div>
						</div>
					</div>

					{#if visibleIds.length > 1 && slot.group}
						{@const dims = gridDimensions(slot.group)}
						{@const liveFr = resizingColFr?.slotKey === slot.key ? resizingColFr.fr : resolveColFr(slot.group, dims.cols)}
						<div
							bind:this={gridEls[slot.key]}
							class="mt-2.5 grid gap-2.5"
							style="grid-template-columns: {liveFr
								.map((fr) => `${fr}fr`)
								.join(' ')}; grid-template-rows: repeat({dims.rows}, auto);"
						>
							{#each slot.group.cells.filter((c) => visibleIds.includes(c.id)) as cell (cell.id)}
								{@const id = cell.id}
								{@const meta = WIDGET_META[id]}
								{@const Icon = meta.icon}
								<div
									data-cell-id={id}
									use:registerCellEl={id}
									class="relative min-w-0 {cell.col > 0 ? 'border-l border-white/10 pl-2.5' : ''} {cell.row > 0
										? 'border-t border-white/10 pt-2.5'
										: ''}"
									style="grid-column: {cell.col + 1} / span {cell.colSpan}; grid-row: {cell.row + 1} / span {cell.rowSpan};"
								>
									{#if cell.col > 0 && dragEnabled && !isNarrowViewport}
										<button
											type="button"
											class="col-divider"
											onpointerdown={(e) => startColumnResize(e, slot, cell.col)}
											title="Drag to resize columns"
											aria-label="Resize column before {meta.label}"
										></button>
									{/if}
									<div class="mb-1.5 flex items-center justify-between gap-2">
										<span
											class="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-white/35 uppercase"
										>
											{#if Icon}
												<Icon size={11} aria-hidden="true" />
											{/if}
											{meta.label}
											{#if id === 'now-playing' || id === 'discord'}
												<span class="relative flex h-1.5 w-1.5" title="Live" aria-hidden="true">
													<span class="absolute h-full w-full animate-ping rounded-full bg-primary opacity-75"
													></span>
													<span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
												</span>
											{/if}
										</span>
										<button
											type="button"
											onclick={() => unlinkWidget(id)}
											title="Unlink {meta.label} from this card"
											aria-label="Unlink {meta.label} widget"
											class="text-white/25 hover:text-primary"
										>
											<Unlink size={11} aria-hidden="true" />
										</button>
									</div>
									{@render widgetBody(id)}
									{#if dragOverEdge?.cellId === id}
										<div class="dock-edge dock-edge--{dragOverEdge.edge} bg-primary" aria-hidden="true"></div>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						{@const soloId = visibleIds[0]}
						<div class="relative mt-2.5" data-cell-id={soloId} use:registerCellEl={soloId}>
							{@render widgetBody(soloId)}
							{#if dragOverEdge?.cellId === soloId}
								<div class="dock-edge dock-edge--{dragOverEdge.edge} bg-primary" aria-hidden="true"></div>
							{/if}
						</div>
					{/if}
					{#if dragEnabled && !isNarrowViewport}
						<button
							type="button"
							class="resize-handle"
							onpointerdown={(e) => startResize(e, slot)}
							title="Drag to resize"
							aria-label="Resize {cardLabel} widget"
						></button>
					{/if}
				</div>
			{/if}
	{/each}
	</div>
	</DragDropProvider>
</main>

<!-- Fixed rather than in main's flow — main uses justify-center to keep the
     clock/search/nav/quick-links block vertically centered, and this bar's
     own height varies with how many widgets are hidden, which would shift
     that centering around every time something got hidden/shown. Same
     reasoning as why the floating cards above are all position:fixed. -->
{#if hiddenIds.size}
	<div
		class="glass fixed bottom-4 left-1/2 z-10 flex max-w-[90vw] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-full px-3 py-1.5"
	>
		<span class="text-[10px] font-medium tracking-wide text-white/35 uppercase">Hidden</span>
			{#each slots.filter((s) => s.ids.every((id) => hiddenIds.has(id))) as slot (slot.key)}
				<button
					type="button"
					onclick={() => unhideSlot(slot)}
					title="Show {slot.ids.map((id) => WIDGET_META[id].label).join(' + ')}"
					class="flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/60 transition-colors hover:border-primary/50 hover:text-primary"
				>
					<Eye size={11} aria-hidden="true" />
					{slot.ids.map((id) => WIDGET_META[id].label).join(' + ')}
				</button>
			{/each}
		</div>
	{/if}

<style>
	/* Scoped to this page only — the site's other pages keep their flat
	   bg-surface cards; this dashboard gets its own glass/aurora treatment
	   since it's meant to feel like a separate "browser chrome" surface
	   rather than a page of the marketing site. */
	.photo-bg {
		position: fixed;
		inset: 0;
		z-index: 0;
		background-size: cover;
		background-position: center;
	}

	/* Dims/tints the photo toward the brand's near-black + cyan/lime so text
	   and the glass panels stay legible regardless of what photo comes back. */
	.photo-bg-scrim {
		position: fixed;
		inset: 0;
		z-index: 0;
		background: linear-gradient(
			160deg,
			rgba(5, 7, 10, 0.75) 0%,
			rgba(5, 7, 10, 0.55) 50%,
			rgba(5, 7, 10, 0.8) 100%
		);
	}

	.aurora {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		background: #05070a;
	}

	.aurora-blob {
		position: absolute;
		border-radius: 9999px;
		filter: blur(90px);
		opacity: 0.55;
		will-change: transform;
	}

	.aurora-blob--1 {
		top: -10%;
		left: -10%;
		width: 45vw;
		height: 45vw;
		background: #22d3ee;
		animation: drift1 26s ease-in-out infinite;
	}

	/* Lime — RG Digital's brand accent (see tokens.css header comment) —
	   paired with RazerGhost's own cyan since the "See my work at RG Digital"
	   link lives on this dashboard too. */
	.aurora-blob--2 {
		bottom: -15%;
		right: -10%;
		width: 40vw;
		height: 40vw;
		background: #ccff00;
		opacity: 0.4;
		animation: drift2 32s ease-in-out infinite;
	}

	.aurora-blob--3 {
		top: 30%;
		left: 55%;
		width: 30vw;
		height: 30vw;
		background: #00e5ff;
		opacity: 0.35;
		animation: drift3 22s ease-in-out infinite;
	}

	@keyframes drift1 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(6vw, 8vh) scale(1.1);
		}
	}

	@keyframes drift2 {
		0%,
		100% {
			transform: translate(0, 0) scale(1);
		}
		50% {
			transform: translate(-5vw, -6vh) scale(1.05);
		}
	}

	@keyframes drift3 {
		0%,
		100% {
			transform: translate(0, 0);
		}
		50% {
			transform: translate(-4vw, 5vh);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.aurora-blob {
			animation: none;
		}
	}

	.glass {
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02));
		border: 1px solid rgba(255, 255, 255, 0.12);
		backdrop-filter: blur(20px) saturate(150%);
		-webkit-backdrop-filter: blur(20px) saturate(150%);
		box-shadow:
			0 8px 32px rgba(0, 0, 0, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.06);
	}

	.glass--interactive:hover {
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.04));
		border-color: rgba(34, 211, 238, 0.4);
	}

	/* Widgets popped out of the grid via their grip handle — see startDrag in
	   the script block. Capped width keeps them from sprawling once they're
	   no longer constrained by the grid column that used to size them. */
	.floating-widget {
		box-shadow:
			0 20px 50px rgba(0, 0, 0, 0.5),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	/* Drag handle for free width-resizing (see startResize) — a small
	   diagonal grip in the card's bottom-right corner. */
	.resize-handle {
		position: absolute;
		right: 2px;
		bottom: 2px;
		width: 14px;
		height: 14px;
		cursor: ew-resize;
		touch-action: none;
		background: linear-gradient(
			135deg,
			transparent 0%,
			transparent 45%,
			rgba(255, 255, 255, 0.3) 45%,
			rgba(255, 255, 255, 0.3) 55%,
			transparent 55%,
			transparent 100%
		);
		border-radius: 0 0 12px 0;
		opacity: 0.6;
	}

	.resize-handle:hover {
		opacity: 1;
	}

	/* Draggable divider between two columns inside a merged card (see
	   startColumnResize) — sits centered over the visual hairline border,
	   wider than the 1px border itself so it's actually grabbable. */
	.col-divider {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -7px;
		width: 14px;
		cursor: ew-resize;
		touch-action: none;
		background: transparent;
	}

	.col-divider:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	/* Dock-zone seam highlight — rendered on the specific sub-widget edge a
	   dragged card is currently close enough to dock onto (see
	   dragOverEdge / dockTargetUnderPoint in the script block). */
	.dock-edge {
		position: absolute;
		border-radius: 2px;
		pointer-events: none;
		opacity: 0.9;
	}

	.dock-edge--top {
		top: -6px;
		left: 4px;
		right: 4px;
		height: 3px;
	}

	.dock-edge--bottom {
		bottom: -6px;
		left: 4px;
		right: 4px;
		height: 3px;
	}

	.dock-edge--left {
		left: -6px;
		top: 4px;
		bottom: 4px;
		width: 3px;
	}

	.dock-edge--right {
		right: -6px;
		top: 4px;
		bottom: 4px;
		width: 3px;
	}
</style>
