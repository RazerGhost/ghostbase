// Pure, framework-free helpers for the /newtab merged-card grid model. A
// "group" is a small 2D grid of cells (mirrors CSS Grid's row/col/span
// concepts) rather than a single ordered chain, so a wide card can sit above
// several narrower cards in the row below it. Kept separate from
// +page.svelte so the row/col math can be reasoned about (and tested)
// without any DOM/Svelte state involved.

export type GroupCell<T extends string = string> = {
	id: T;
	row: number;
	col: number;
	rowSpan: number;
	colSpan: number;
};

// `colFr` is the user-adjustable column-width ratio (CSS grid `fr` units,
// one entry per column) set by dragging a divider between two cells — see
// startColumnResize in +page.svelte. Rows stay content-sized (`auto`) since
// there's no bounded container height to divide, only a bounded width, so
// there's no `rowFr` counterpart. Omitted/length-mismatched means "not set
// yet, use equal widths" — see resolveColFr.
export type WidgetGroup<T extends string = string> = {
	cells: GroupCell<T>[];
	colFr?: number[];
};

export type DockEdge = 'top' | 'right' | 'bottom' | 'left';

export function gridDimensions<T extends string>(group: WidgetGroup<T>): { rows: number; cols: number } {
	let rows = 0;
	let cols = 0;
	for (const cell of group.cells) {
		rows = Math.max(rows, cell.row + cell.rowSpan);
		cols = Math.max(cols, cell.col + cell.colSpan);
	}
	return { rows, cols };
}

// The effective per-column fr sizing to render with — falls back to equal
// widths when nothing's been dragged yet, or when the column count changed
// out from under a previously-set ratio (insert/remove/repack all drop
// colFr for exactly this reason, see below).
export function resolveColFr<T extends string>(group: WidgetGroup<T>, cols: number): number[] {
	if (group.colFr && group.colFr.length === cols) return group.colFr;
	return new Array(cols).fill(1);
}

export function cellFor<T extends string>(group: WidgetGroup<T>, id: T): GroupCell<T> | undefined {
	return group.cells.find((c) => c.id === id);
}

export function cellAt<T extends string>(group: WidgetGroup<T>, row: number, col: number): GroupCell<T> | undefined {
	return group.cells.find(
		(c) => row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan
	);
}

// Which edge (if any) of `rect` the pointer is close enough to for a dock
// zone to activate — requires the pointer to also fall within the rect's
// perpendicular bounds, not just be near the infinite line the edge sits on
// (otherwise a pointer far above-left of a card could "hit" its left edge).
export function edgeDockTarget(
	rect: { left: number; top: number; right: number; bottom: number },
	pointerX: number,
	pointerY: number,
	threshold = 20
): DockEdge | null {
	const withinX = pointerX >= rect.left && pointerX <= rect.right;
	const withinY = pointerY >= rect.top && pointerY <= rect.bottom;
	if (!withinX || !withinY) return null;

	const distances: { edge: DockEdge; dist: number }[] = [
		{ edge: 'left', dist: pointerX - rect.left },
		{ edge: 'right', dist: rect.right - pointerX },
		{ edge: 'top', dist: pointerY - rect.top },
		{ edge: 'bottom', dist: rect.bottom - pointerY }
	];
	const nearest = distances.reduce((a, b) => (b.dist < a.dist ? b : a));
	return nearest.dist <= threshold ? nearest.edge : null;
}

// Inserts `newId` adjacent to `targetId` on the given edge. This is the
// direct effect of a drop, not the "silent reflow" the spec warns against —
// that prohibition is specifically about *unlinking*, not about making room
// for the card the user just dropped. Drops any prior colFr in every case —
// the column count/meaning just changed, so a stale ratio would either be
// silently ignored (resolveColFr's length check) or apply to the wrong
// columns; resetting to equal widths is the least surprising outcome.
//
// left/right: if the target is a single-column cell, this grows the grid by
// one column exactly like before. But if the target is itself a *spanning*
// cell (colSpan > 1 — e.g. a card already stretched across a row of cells
// below it, or one just created by the top/bottom case below), docking
// beside it splits its own span to make room instead of growing the grid
// further — so docking a 4th card beside a full-width 3rd card divides that
// row rather than producing a mismatched, ever-wider grid.
//
// top/bottom: rather than only spanning the target cell's own column, the
// new card spans the full width of the target's *entire row* (every cell
// sharing target.row) — so docking under one of several side-by-side merged
// cards produces a single wide card under all of them, not a narrow column
// wedged under just the one it happened to land on.
export function insertCell<T extends string>(
	group: WidgetGroup<T>,
	targetId: T,
	edge: DockEdge,
	newId: T
): WidgetGroup<T> {
	const target = cellFor(group, targetId);
	if (!target) return group;

	if (edge === 'left' || edge === 'right') {
		if (target.colSpan > 1) {
			const shrunk = target.colSpan - 1;
			const newCol = edge === 'left' ? target.col : target.col + shrunk;
			const targetCol = edge === 'left' ? target.col + 1 : target.col;
			const cells = group.cells.map((c) => (c.id === targetId ? { ...c, col: targetCol, colSpan: shrunk } : c));
			const split: WidgetGroup<T> = {
				cells: [...cells, { id: newId, row: target.row, col: newCol, rowSpan: target.rowSpan, colSpan: 1 }]
			};
			// The target may itself have a row of cells docked beneath it
			// (from an earlier bottom-dock) sized to its old, wider span —
			// repack that row into the new, narrower one too.
			return repackRowUnderSpan(split, targetId, shrunk);
		}
		const insertCol = edge === 'left' ? target.col : target.col + target.colSpan;
		const shifted = group.cells.map((c) => (c.col >= insertCol ? { ...c, col: c.col + 1 } : c));
		return { cells: [...shifted, { id: newId, row: target.row, col: insertCol, rowSpan: target.rowSpan, colSpan: 1 }] };
	}

	const rowCells = group.cells.filter((c) => c.row === target.row);
	const rowMinCol = Math.min(...rowCells.map((c) => c.col));
	const rowMaxCol = Math.max(...rowCells.map((c) => c.col + c.colSpan));
	const rowSpan = rowCells.reduce((max, c) => Math.max(max, c.rowSpan), target.rowSpan);

	const insertRow = edge === 'top' ? target.row : target.row + rowSpan;
	const shifted = group.cells.map((c) => (c.row >= insertRow ? { ...c, row: c.row + 1 } : c));
	return {
		cells: [...shifted, { id: newId, row: insertRow, col: rowMinCol, rowSpan: 1, colSpan: rowMaxCol - rowMinCol }]
	};
}

// Drops a cell without touching anyone else's row/col — the vacated slot
// just stays empty (a valid dock target for a future drop) rather than the
// remaining cells re-stretching to fill the gap. Drops colFr for the same
// reason as insertCell.
export function removeCell<T extends string>(group: WidgetGroup<T>, id: T): WidgetGroup<T> {
	return { cells: group.cells.filter((c) => c.id !== id) };
}

// The one explicit auto-reflow case: when a spanning cell's colSpan changes,
// re-pack the cells in the row immediately below it (that were previously
// spanned underneath it) left-to-right into the new column count, so
// shrinking a 3-wide card down to 2 doesn't leave its former underlings
// overflowing or stranded past the new edge. Drops colFr for the same
// reason as insertCell.
export function repackRowUnderSpan<T extends string>(
	group: WidgetGroup<T>,
	spanningId: T,
	newColSpan: number
): WidgetGroup<T> {
	const spanning = cellFor(group, spanningId);
	if (!spanning) return group;

	const belowRow = spanning.row + spanning.rowSpan;
	const below = group.cells
		.filter((c) => c.row === belowRow && c.col >= spanning.col && c.col < spanning.col + spanning.colSpan)
		.sort((a, b) => a.col - b.col);

	const packedCols = Math.max(1, newColSpan);
	const rest = group.cells.filter((c) => c.id === spanningId || !below.some((b) => b.id === c.id));
	const repacked = below.map((c, i) => ({
		...c,
		col: spanning.col + Math.floor((i * packedCols) / Math.max(below.length, 1)),
		colSpan: Math.max(1, Math.floor(packedCols / Math.max(below.length, 1)))
	}));

	return { cells: rest.map((c) => (c.id === spanningId ? { ...c, colSpan: newColSpan } : c)).concat(repacked) };
}

// Sets the column-width ratio directly — used when a divider drag finishes
// (see startColumnResize in +page.svelte). Doesn't touch cell layout at all.
export function setColFr<T extends string>(group: WidgetGroup<T>, colFr: number[]): WidgetGroup<T> {
	return { ...group, colFr };
}
