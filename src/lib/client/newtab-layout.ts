// Client-only persistence for /newtab's free-floating widgets — deliberately
// NOT server-backed (unlike quick links / focus sessions / etc.) since a
// dragged position is a per-device UI preference, not data worth syncing.
const STORAGE_KEY = 'newtab:floating-positions';

export type FloatPosition = { x: number; y: number; width: number };

function readAll(): Record<string, FloatPosition> {
	if (typeof localStorage === 'undefined') return {};
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
	} catch {
		return {};
	}
}

function writeAll(positions: Record<string, FloatPosition>): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
}

export function getFloatPosition(id: string): FloatPosition | null {
	return readAll()[id] ?? null;
}

export function setFloatPosition(id: string, pos: FloatPosition): void {
	const all = readAll();
	all[id] = pos;
	writeAll(all);
}

export function clearFloatPosition(id: string): void {
	const all = readAll();
	delete all[id];
	writeAll(all);
}

export function resetAllFloatPositions(): void {
	localStorage.removeItem(STORAGE_KEY);
}

// Which widgets are hidden from the canvas entirely — separate key again, same
// reasoning as order/full-width above. Hidden widgets stay in the "hidden"
// list so they can be brought back rather than losing their saved position.
const HIDDEN_KEY = 'newtab:hidden-widgets';

export function getHiddenWidgetIds(): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(HIDDEN_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

export function setHiddenWidgetIds(ids: string[]): void {
	localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
}

export function resetHiddenWidgets(): void {
	localStorage.removeItem(HIDDEN_KEY);
}

// Widgets merged into a single combined card — an array of groups, each a
// small 2D grid of cells (row/col/rowSpan/colSpan, mirrors CSS Grid) that
// render inside one shared card instead of as separate cards. This lets a
// wide card span above several narrower cards in the row below it, not just
// a single ordered chain. Same per-device-preference reasoning as everything
// else in this file.
const GROUPS_KEY = 'newtab:widget-groups';

export type WidgetGroupCell = { id: string; row: number; col: number; rowSpan: number; colSpan: number };
export type WidgetGroup = { cells: WidgetGroupCell[]; colFr?: number[] };

// Two-step migration, both transparent the first time this is read in a
// browser that still has an older shape saved:
//   1. flat chain (`string[][]`, always a single horizontal row)
//   2. bare grid-cell array (`WidgetGroupCell[]`, no column-width ratios)
// both fold into the current `{ cells, colFr? }` shape.
function migrateLegacyGroup(raw: unknown): WidgetGroup | null {
	if (Array.isArray(raw)) {
		if (raw.every((id) => typeof id === 'string')) {
			return { cells: (raw as string[]).map((id, i) => ({ id, row: 0, col: i, rowSpan: 1, colSpan: 1 })) };
		}
		if (raw.every((cell) => cell && typeof cell === 'object' && typeof cell.id === 'string')) {
			return { cells: raw as WidgetGroupCell[] };
		}
		return null;
	}
	if (raw && typeof raw === 'object' && Array.isArray((raw as WidgetGroup).cells)) {
		return raw as WidgetGroup;
	}
	return null;
}

export function getWidgetGroups(): WidgetGroup[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const raw = localStorage.getItem(GROUPS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const migrated = parsed.map(migrateLegacyGroup).filter((g): g is WidgetGroup => g !== null);
		// Persist the migrated shape so this only has to happen once.
		if (JSON.stringify(migrated) !== raw) setWidgetGroups(migrated);
		return migrated;
	} catch {
		return [];
	}
}

export function setWidgetGroups(groups: WidgetGroup[]): void {
	localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
}

export function resetWidgetGroups(): void {
	localStorage.removeItem(GROUPS_KEY);
}

// Whether the quick links row is displayed sorted by click count instead of
// the saved manual order — a per-device display preference, same reasoning
// as everything else in this file.
const QUICK_LINKS_SORT_KEY = 'newtab:quick-links-sort-by-clicks';

export function getQuickLinksSortByClicks(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(QUICK_LINKS_SORT_KEY) === '1';
}

export function setQuickLinksSortByClicks(sortByClicks: boolean): void {
	if (sortByClicks) localStorage.setItem(QUICK_LINKS_SORT_KEY, '1');
	else localStorage.removeItem(QUICK_LINKS_SORT_KEY);
}
