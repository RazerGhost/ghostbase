import { getStatus } from '$lib/server/status-db';
import { getBackgroundPhoto, defaultUnsplashQuery, unsplashConfigured } from '$lib/server/unsplash';
import { getUpcomingEvents, type AgendaEvent } from '$lib/server/calendar';
import {
	getNewtabSettings,
	setNewtabUnsplashQuery,
	setNewtabIcsUrl,
	getQuickLinks,
	addQuickLink,
	updateQuickLink,
	removeQuickLink,
	incrementQuickLinkClicks,
	moveQuickLink,
	listPhotoHistory,
	pickRandomPhotoHistory,
	toggleFavoritePhoto,
	getPhotoHistoryEntry,
	getFocusStats,
	getFocusWeeklyStats,
	logFocusSession,
	getRecentSearches,
	logSearch,
	removeSearch,
	getTodoItems,
	addTodoItem,
	toggleTodoItem,
	removeTodoItem
} from '$lib/server/newtab-settings';
import { getLibraryWithFallback, simklConfigured } from '$lib/server/simkl';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const status = getStatus();
	const settings = getNewtabSettings();
	const unsplashQuery = settings.unsplashQuery || defaultUnsplashQuery();
	const photo = await getBackgroundPhoto(unsplashQuery);
	const quickLinks = getQuickLinks();

	let watching: Awaited<ReturnType<typeof getLibraryWithFallback>>['library']['watching'] = [];
	if (simklConfigured()) {
		try {
			const { library } = await getLibraryWithFallback();
			watching = library.watching.slice(0, 3);
		} catch {
			watching = [];
		}
	}

	let agenda: AgendaEvent[] = [];
	if (settings.icsUrl) {
		try {
			agenda = await getUpcomingEvents(settings.icsUrl);
		} catch {
			agenda = [];
		}
	}

	return {
		statusItems: status.items,
		photo,
		unsplashQuery,
		unsplashConfigured: unsplashConfigured(),
		quickLinks,
		watching,
		icsUrl: settings.icsUrl,
		agenda,
		photoHistory: listPhotoHistory(),
		focusStats: getFocusStats(),
		focusWeekly: getFocusWeeklyStats(),
		recentSearches: getRecentSearches(),
		todoItems: getTodoItems()
	};
};

export const actions: Actions = {
	updateBackground: async ({ request }) => {
		const data = await request.formData();
		const query = String(data.get('query') ?? '').trim();
		setNewtabUnsplashQuery(query || null);
		return { success: true };
	},

	updateIcsUrl: async ({ request }) => {
		const data = await request.formData();
		const url = String(data.get('icsUrl') ?? '').trim();
		setNewtabIcsUrl(url || null);
		return { success: true };
	},

	cyclePhoto: async ({ request }) => {
		const data = await request.formData();
		const currentUrl = String(data.get('currentUrl') ?? '');
		const picked = pickRandomPhotoHistory(currentUrl);
		return { success: Boolean(picked), photo: picked };
	},

	favoritePhoto: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return { success: false };
		toggleFavoritePhoto(id);
		return { success: true };
	},

	selectPhoto: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const entry = id ? getPhotoHistoryEntry(id) : null;
		return { success: Boolean(entry), photo: entry };
	},

	addQuickLink: async ({ request }) => {
		const data = await request.formData();
		const label = String(data.get('label') ?? '').trim();
		let url = String(data.get('url') ?? '').trim();
		const icon = String(data.get('icon') ?? '').trim() || null;
		const shortcut = String(data.get('shortcut') ?? '').trim().slice(0, 1).toLowerCase() || null;
		if (!label || !url) return { success: false };
		if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
		addQuickLink(label, url, icon, shortcut);
		return { success: true };
	},

	editQuickLink: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const label = String(data.get('label') ?? '').trim();
		let url = String(data.get('url') ?? '').trim();
		const icon = String(data.get('icon') ?? '').trim() || null;
		const shortcut = String(data.get('shortcut') ?? '').trim().slice(0, 1).toLowerCase() || null;
		if (!id || !label || !url) return { success: false };
		if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
		updateQuickLink(id, { label, url, icon, shortcut });
		return { success: true };
	},

	removeQuickLink: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return { success: false };
		removeQuickLink(id);
		return { success: true };
	},

	moveQuickLink: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const direction = String(data.get('direction') ?? '') === 'up' ? 'up' : 'down';
		if (!id) return { success: false };
		moveQuickLink(id, direction);
		return { success: true };
	},

	clickQuickLink: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return { success: false };
		incrementQuickLinkClicks(id);
		return { success: true };
	},

	logSearch: async ({ request }) => {
		const data = await request.formData();
		const query = String(data.get('query') ?? '');
		logSearch(query);
		return { success: true };
	},

	removeSearch: async ({ request }) => {
		const data = await request.formData();
		const query = String(data.get('query') ?? '');
		if (!query) return { success: false };
		removeSearch(query);
		return { success: true };
	},

	addTodo: async ({ request }) => {
		const data = await request.formData();
		const body = String(data.get('body') ?? '').trim();
		if (!body) return { success: false };
		const item = addTodoItem(body);
		return { success: true, item };
	},

	toggleTodo: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return { success: false };
		toggleTodoItem(id);
		return { success: true };
	},

	removeTodo: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return { success: false };
		removeTodoItem(id);
		return { success: true };
	},

	logFocusSession: async ({ request }) => {
		const data = await request.formData();
		const kind = String(data.get('kind') ?? '') === 'break' ? 'break' : 'focus';
		const completed = String(data.get('completed') ?? '') === 'true';
		const startedAt = String(data.get('startedAt') ?? '');
		const endedAt = String(data.get('endedAt') ?? '');
		if (!startedAt || !endedAt) return { success: false };
		logFocusSession(kind, completed, startedAt, endedAt);
		return { success: true };
	}
};
