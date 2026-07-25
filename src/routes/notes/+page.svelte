<script lang="ts">
	import { richMarked, markTaskListItems } from '$lib/markdown';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import { tooltip } from '$lib/actions/tooltip';
	import { untrack } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// ── Mobile: the force-graph canvas relies on hover/drag/keyboard
	// interactions that don't translate to touch, so small screens get a
	// plain list + full-screen editor instead (see the {#if isMobile} branch
	// near the bottom of the markup). Both branches share the same state.
	let isMobile = $state(false);
	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia('(max-width: 768px)');
		isMobile = mq.matches;
		const onChange = (e: MediaQueryListEvent) => (isMobile = e.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	type GraphNote = {
		id: number;
		title: string;
		x: number | null;
		y: number | null;
		tags: string;
		folder: string;
		updated_at: string;
	};
	type GraphLink = {
		id: number;
		source_id: number;
		target_id: number;
		label: string | null;
		directed: number;
	};
	type SimNode = {
		id: number;
		title: string;
		x: number;
		y: number;
		vx: number;
		vy: number;
		tags: string;
		folder: string;
		updated_at: string;
	};

	// ── Physics constants ────────────────────────────────────────────
	const REPEL = 2800;
	const LINK_DISTANCE = 170;
	const LINK_STRENGTH = 0.02;
	const CENTER_STRENGTH = 0.004;
	const DAMPING = 0.82;
	const MIN_DIST = 46;
	const SETTLE_EPS = 0.02;

	const TEMPLATES = [
		{ name: 'Blank', body: '' },
		{ name: 'Meeting', body: '## Attendees\n\n## Agenda\n\n## Notes\n\n## Action items\n- [ ] ' },
		{ name: 'Idea', body: '## The idea\n\n## Why it matters\n\n## Next steps\n' },
		{ name: 'Checklist', body: '- [ ] \n- [ ] \n- [ ] ' }
	];

	// ── Control dock: sticky tool mode replaces one-off modifier-key combos.
	// Holding shift/ctrl/alt still works as a power-user shortcut for the
	// matching tool (see effectiveTool), the dock is just the discoverable path.
	type Tool = 'default' | 'link' | 'path' | 'select';
	let tool = $state<Tool>('default');
	const TOOLS: { id: Tool; label: string; hint: string }[] = [
		{ id: 'default', label: 'Pointer', hint: 'Drag notes to move them, click to open, drag the canvas to pan' },
		{ id: 'link', label: 'Link', hint: 'Drag from one note to another to connect them' },
		{ id: 'path', label: 'Path', hint: 'Click two notes to trace the shortest connection between them' },
		{ id: 'select', label: 'Select', hint: 'Click notes, or drag a box, to multi-select — then link them all to one note' }
	];
	function effectiveTool(e: PointerEvent): Tool {
		if (e.shiftKey) return 'link';
		if (e.ctrlKey) return 'path';
		if (e.altKey) return 'select';
		return tool;
	}

	function scatterPoint(i: number) {
		const angle = i * 2.399963; // golden angle spiral, avoids initial overlap
		const radius = 40 * Math.sqrt(i + 1);
		return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
	}

	function splitTags(tags: string): string[] {
		return tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
	}

	function tagColor(tag: string): string {
		let hash = 0;
		for (const c of tag) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
		return `hsl(${hash % 360} 70% 55%)`;
	}

	let nodes = $state<SimNode[]>(
		untrack(() =>
			data.notes.map((n: GraphNote, i: number) => {
				const fallback = scatterPoint(i);
				return {
					id: n.id,
					title: n.title,
					x: n.x ?? fallback.x,
					y: n.y ?? fallback.y,
					vx: 0,
					vy: 0,
					tags: n.tags ?? '',
					folder: n.folder ?? '',
					updated_at: n.updated_at
				};
			})
		)
	);
	let links = $state<GraphLink[]>(untrack(() => data.links.map((l: GraphLink) => ({ ...l }))));

	const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));
	const connectionCount = $derived.by(() => {
		const counts = new Map<number, number>();
		for (const l of links) {
			counts.set(l.source_id, (counts.get(l.source_id) ?? 0) + 1);
			counts.set(l.target_id, (counts.get(l.target_id) ?? 0) + 1);
		}
		return counts;
	});

	function radiusFor(id: number) {
		const c = connectionCount.get(id) ?? 0;
		return Math.min(22 + c * 5, 46);
	}

	// ── Tags / folders / filtering ────────────────────────────────────
	let tagFilter = $state<string | null>(null);
	let folderFilter = $state<string | null>(null);
	let dimOrphans = $state(false);

	const allTags = $derived.by(() => {
		const set = new Set<string>();
		for (const n of nodes) for (const t of splitTags(n.tags)) set.add(t);
		return [...set].sort();
	});

	const allFolders = $derived.by(() => {
		const set = new Set<string>();
		for (const n of nodes) if (n.folder.trim()) set.add(n.folder.trim());
		return [...set].sort();
	});

	function nodeOpacity(id: number): number {
		const node = nodeById.get(id);
		if (!node) return 1;
		if (tagFilter && !splitTags(node.tags).includes(tagFilter)) return 0.2;
		if (folderFilter && node.folder.trim() !== folderFilter) return 0.2;
		if (dimOrphans && (connectionCount.get(id) ?? 0) === 0) return 0.3;
		return 1;
	}

	// ── View transform (pan/zoom) ───────────────────────────────────
	let viewX = $state(0);
	let viewY = $state(0);
	let zoom = $state(1);
	let canvasEl: HTMLDivElement;

	function centerView() {
		const rect = canvasEl?.getBoundingClientRect();
		if (!rect) return;
		viewX = rect.width / 2;
		viewY = rect.height / 2;
	}

	const bounds = $derived.by(() => {
		if (nodes.length === 0) return { minX: -200, minY: -200, maxX: 200, maxY: 200 };
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x);
			maxX = Math.max(maxX, n.x);
			minY = Math.min(minY, n.y);
			maxY = Math.max(maxY, n.y);
		}
		const pad = 60;
		return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
	});

	function fitToView() {
		if (nodes.length === 0 || !canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const w = bounds.maxX - bounds.minX;
		const h = bounds.maxY - bounds.minY;
		zoom = Math.max(0.15, Math.min(rect.width / w, rect.height / h, 1.5));
		const cx = (bounds.minX + bounds.maxX) / 2;
		const cy = (bounds.minY + bounds.maxY) / 2;
		viewX = rect.width / 2 - cx * zoom;
		viewY = rect.height / 2 - cy * zoom;
	}

	// ── Minimap ──────────────────────────────────────────────────────
	const MINIMAP_W = 150;
	const MINIMAP_H = 110;

	function minimapScale() {
		const w = bounds.maxX - bounds.minX || 1;
		const h = bounds.maxY - bounds.minY || 1;
		return Math.min(MINIMAP_W / w, MINIMAP_H / h);
	}

	function minimapPoint(x: number, y: number) {
		const s = minimapScale();
		return { x: (x - bounds.minX) * s, y: (y - bounds.minY) * s };
	}

	function minimapViewport() {
		if (!canvasEl) return { x: 0, y: 0, w: 0, h: 0 };
		const rect = canvasEl.getBoundingClientRect();
		const s = minimapScale();
		return {
			x: (-viewX / zoom - bounds.minX) * s,
			y: (-viewY / zoom - bounds.minY) * s,
			w: (rect.width / zoom) * s,
			h: (rect.height / zoom) * s
		};
	}

	function onMinimapClick(e: MouseEvent) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const s = minimapScale();
		const worldX = (e.clientX - rect.left) / s + bounds.minX;
		const worldY = (e.clientY - rect.top) / s + bounds.minY;
		const canvasRect = canvasEl.getBoundingClientRect();
		viewX = canvasRect.width / 2 - worldX * zoom;
		viewY = canvasRect.height / 2 - worldY * zoom;
	}

	// ── Clusters ─────────────────────────────────────────────────────
	type Cluster = { key: string; ids: number[]; x: number; y: number };

	const clusters = $derived.by((): Cluster[] => {
		const parent = new Map<number, number>();
		const find = (start: number): number => {
			let root = start;
			while (parent.get(root) !== root) root = parent.get(root)!;
			let cur = start;
			while (parent.get(cur) !== root) {
				const next = parent.get(cur)!;
				parent.set(cur, root);
				cur = next;
			}
			return root;
		};
		for (const n of nodes) parent.set(n.id, n.id);
		for (const l of links) {
			if (!parent.has(l.source_id) || !parent.has(l.target_id)) continue;
			const ra = find(l.source_id);
			const rb = find(l.target_id);
			if (ra !== rb) parent.set(ra, rb);
		}
		const groups = new Map<number, number[]>();
		for (const n of nodes) {
			const root = find(n.id);
			if (!groups.has(root)) groups.set(root, []);
			groups.get(root)!.push(n.id);
		}
		const result: Cluster[] = [];
		for (const ids of groups.values()) {
			// A 2-note cluster is just "one link" — its auto-name (both titles
			// joined) only restates what's already visible in the two node
			// circles, and it competes for the same space as the link's own
			// label. Cluster labels start earning their keep at 3+ notes,
			// where they summarize a neighborhood you can't read at a glance.
			if (ids.length < 3) continue;
			let sx = 0,
				sy = 0;
			for (const id of ids) {
				const node = nodeById.get(id);
				if (node) {
					sx += node.x;
					sy += node.y;
				}
			}
			result.push({
				key: [...ids].sort((a, b) => a - b).join('-'),
				ids,
				x: sx / ids.length,
				y: sy / ids.length
			});
		}
		return result;
	});

	let clusterNames = $state<Record<string, string>>({});
	$effect(() => {
		if (!browser) return;
		try {
			clusterNames = JSON.parse(localStorage.getItem('notes-cluster-names') ?? '{}');
		} catch {
			clusterNames = {};
		}
	});

	function clusterLabel(c: Cluster): string {
		if (clusterNames[c.key]) return clusterNames[c.key];
		const titles = c.ids.map((id) => nodeById.get(id)?.title || 'Untitled');
		return titles.length <= 2 ? titles.join(' & ') : `${titles[0]} +${titles.length - 1} more`;
	}

	function renameCluster(c: Cluster) {
		const name = window.prompt('Name this cluster:', clusterLabel(c));
		if (name === null) return;
		clusterNames = { ...clusterNames, [c.key]: name.trim() };
		if (browser) localStorage.setItem('notes-cluster-names', JSON.stringify(clusterNames));
	}

	// ── Recently viewed ──────────────────────────────────────────────
	let recentIds = $state<number[]>([]);
	$effect(() => {
		if (!browser) return;
		try {
			recentIds = JSON.parse(localStorage.getItem('notes-recent') ?? '[]');
		} catch {
			recentIds = [];
		}
	});
	function pushRecent(id: number) {
		recentIds = [id, ...recentIds.filter((r) => r !== id)].slice(0, 6);
		if (browser) localStorage.setItem('notes-recent', JSON.stringify(recentIds));
	}
	const recentNotes = $derived(
		recentIds.map((id) => nodeById.get(id)).filter((n): n is SimNode => !!n)
	);

	// ── Selection / panel ────────────────────────────────────────────
	let selectedId = $state<number | null>(null);
	let panelTitle = $state('');
	let panelBody = $state('');
	let panelTags = $state('');
	let panelFolder = $state('');
	let panelMode = $state<'write' | 'preview' | 'history'>('write');
	let panelView = $state<'view' | 'edit'>('view');
	let panelDirty = $state(false);
	let panelError = $state('');
	let panelSaving = $state(false);
	let loadingNote = $state(false);
	let bodyTextareaEl: HTMLTextAreaElement | undefined = $state();

	function toggleChecklistItem(body: string, index: number): string {
		let count = -1;
		return body.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (match, prefix, mark) => {
			count++;
			if (count !== index) return match;
			return `${prefix}[${mark.trim() ? ' ' : 'x'}]`;
		});
	}

	function makeChecklistInteractive(html: string): string {
		let idx = -1;
		return html.replace(/<input\b([^>]*type="checkbox"[^>]*?)\/?>/g, (_m, attrs) => {
			idx++;
			const cleaned = attrs.replace(/\s*disabled(="[^"]*")?/i, '');
			return `<input${cleaned} data-cb-index="${idx}">`;
		});
	}

	// [[Note Title]] resolves to a clickable link if a note with that exact
	// title (case-insensitive) exists, otherwise renders as plain dimmed text.
	function resolveWikiLinks(body: string): string {
		return body.replace(/\[\[([^\]]+)\]\]/g, (_m, title) => {
			const clean = String(title).trim();
			const target = nodes.find((n) => n.title.toLowerCase() === clean.toLowerCase());
			return target
				? `<a href="#" data-wiki-note="${target.id}" class="link text-primary">${clean}</a>`
				: `<span class="text-dim">[[${clean}]]</span>`;
		});
	}

	const previewHtml = $derived(
		makeChecklistInteractive(
			markTaskListItems(richMarked.parse(resolveWikiLinks(panelBody), { async: false }) as string)
		)
	);

	function onPreviewClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT' && target.getAttribute('type') === 'checkbox') {
			const idxAttr = target.getAttribute('data-cb-index');
			if (idxAttr === null) return;
			panelBody = toggleChecklistItem(panelBody, Number(idxAttr));
			panelDirty = true;
			savePanel();
			return;
		}
		const wikiId = target.closest('[data-wiki-note]')?.getAttribute('data-wiki-note');
		if (wikiId) {
			e.preventDefault();
			focusNode(Number(wikiId));
		}
	}

	// Auto-links any [[Note Title]] references found in the body to the
	// matching note, so wiki-links become real graph edges on save.
	async function autoLinkWikiRefs(fromId: number) {
		const matches = [...panelBody.matchAll(/\[\[([^\]]+)\]\]/g)];
		for (const m of matches) {
			const title = m[1].trim().toLowerCase();
			const target = nodes.find((n) => n.id !== fromId && n.title.toLowerCase() === title);
			if (!target) continue;
			const exists = links.some(
				(l) =>
					(l.source_id === fromId && l.target_id === target.id) ||
					(l.source_id === target.id && l.target_id === fromId)
			);
			if (exists) continue;
			const fd = new FormData();
			fd.set('a', String(fromId));
			fd.set('b', String(target.id));
			const res = await fetch('/notes?/link', { method: 'POST', body: fd });
			if (res.ok) {
				links.push({
					id: -Date.now() - target.id,
					source_id: Math.min(fromId, target.id),
					target_id: Math.max(fromId, target.id),
					label: null,
					directed: 0
				});
				wake();
			}
		}
	}

	let revisions = $state<{ id: number; title: string; created_at: string }[]>([]);

	async function loadRevisions(id: number) {
		const res = await fetch(`/api/notes/${id}/revisions`);
		revisions = res.ok ? await res.json() : [];
	}

	async function restoreRevision(revisionId: number) {
		if (selectedId === null) return;
		const fd = new FormData();
		fd.set('revisionId', String(revisionId));
		const res = await fetch('/notes?/restoreRevision', { method: 'POST', body: fd });
		if (!res.ok) return;
		await selectNote(selectedId);
		panelMode = 'write';
	}

	async function selectNote(id: number) {
		// Flush any pending autosave for the outgoing note before the panel
		// fields are overwritten — otherwise the debounce timer could fire
		// while the panel already holds the incoming note's content (writing
		// it to the wrong note), or the last edit would silently be dropped.
		clearTimeout(autosaveTimer);
		if (panelDirty && selectedId !== null && selectedId !== id) {
			await savePanel(selectedId);
			if (panelDirty) {
				// Flush failed — stay on the outgoing note so the unsaved edit
				// and panelError are visible instead of being silently dropped.
				return;
			}
		}
		selectedId = id;
		panelError = '';
		panelMode = 'write';
		panelView = 'view';
		loadingNote = true;
		const res = await fetch(`/api/notes/${id}`);
		loadingNote = false;
		if (!res.ok) {
			panelError = 'Failed to load note.';
			return;
		}
		const note = await res.json();
		panelTitle = note.title;
		panelBody = note.body;
		panelTags = note.tags ?? '';
		panelFolder = note.folder ?? '';
		panelDirty = false;
		pushRecent(id);
		loadRevisions(id);
	}

	function closePanel() {
		selectedId = null;
		panelDirty = false;
		panelView = 'view';
	}

	// Mobile editor's "Back" button: flush any pending edit before leaving,
	// same reasoning as selectNote's flush (avoid a lost debounced save).
	async function mobileBack() {
		clearTimeout(autosaveTimer);
		if (panelDirty) await savePanel();
		closePanel();
	}

	// Saves the panel's current content to `id` — callers must only pass an
	// id whose content is actually in the panel (see selectNote's flush).
	async function savePanel(id: number | null = selectedId) {
		if (id === null) return;
		panelSaving = true;
		const fd = new FormData();
		fd.set('id', String(id));
		fd.set('title', panelTitle.trim());
		fd.set('body', panelBody);
		fd.set('tags', panelTags);
		fd.set('folder', panelFolder);
		const res = await fetch('/notes?/update', { method: 'POST', body: fd });
		panelSaving = false;
		if (!res.ok) {
			panelError = 'Failed to save.';
			return;
		}
		const node = nodeById.get(id);
		if (node) {
			node.title = panelTitle.trim() || 'Untitled';
			node.tags = panelTags;
			node.folder = panelFolder;
		}
		if (selectedId === id) panelDirty = false;
		autoLinkWikiRefs(id);
	}

	// Debounced autosave: fires ~900ms after the last edit while dirty. The
	// explicit Save button still works for an immediate save. The note id is
	// captured at schedule time so a fire after a note switch can never write
	// to the newly-selected note.
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void panelTitle;
		void panelBody;
		void panelTags;
		void panelFolder;
		if (!panelDirty || selectedId === null) return;
		const id = selectedId;
		clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => savePanel(id), 900);
		return () => clearTimeout(autosaveTimer);
	});

	// ── Delete with undo ─────────────────────────────────────────────
	// Deletes are soft (see notes.ts) so undo just flips deleted_at back off
	// server-side; client-side we keep a snapshot to restore the node/links
	// without a full reload while the toast is up.
	let deletedToast = $state<{ id: number; title: string } | null>(null);
	let deletedSnapshot: { node: SimNode; links: GraphLink[] } | null = null;
	let deleteToastTimer: ReturnType<typeof setTimeout> | undefined;

	async function deleteSelected() {
		if (selectedId === null) return;
		const id = selectedId;
		const node = nodeById.get(id);
		if (!node) return;
		deletedSnapshot = {
			node: { ...node },
			links: links.filter((l) => l.source_id === id || l.target_id === id).map((l) => ({ ...l }))
		};
		const fd = new FormData();
		fd.set('id', String(id));
		const res = await fetch('/notes?/delete', { method: 'POST', body: fd });
		if (!res.ok) {
			panelError = 'Failed to delete.';
			deletedSnapshot = null;
			return;
		}
		nodes = nodes.filter((n) => n.id !== id);
		links = links.filter((l) => l.source_id !== id && l.target_id !== id);
		closePanel();

		clearTimeout(deleteToastTimer);
		deletedToast = { id, title: node.title || 'Untitled' };
		deleteToastTimer = setTimeout(() => {
			deletedToast = null;
			deletedSnapshot = null;
		}, 6000);
	}

	async function undoDelete() {
		if (!deletedToast || !deletedSnapshot) return;
		const fd = new FormData();
		fd.set('id', String(deletedToast.id));
		const res = await fetch('/notes?/undoDelete', { method: 'POST', body: fd });
		if (res.ok) {
			nodes.push(deletedSnapshot.node);
			links.push(...deletedSnapshot.links);
			wake();
		}
		clearTimeout(deleteToastTimer);
		deletedToast = null;
		deletedSnapshot = null;
	}

	async function unlink(linkId: number) {
		const fd = new FormData();
		fd.set('id', String(linkId));
		await fetch('/notes?/unlink', { method: 'POST', body: fd });
		links = links.filter((l) => l.id !== linkId);
		wake();
	}

	async function relabelLink(linkId: number, currentLabel: string | null) {
		const name = window.prompt('Connection label:', currentLabel ?? '');
		if (name === null) return;
		const fd = new FormData();
		fd.set('id', String(linkId));
		fd.set('label', name.trim());
		await fetch('/notes?/relabel', { method: 'POST', body: fd });
		const link = links.find((l) => l.id === linkId);
		if (link) link.label = name.trim() || null;
	}

	const selectedLinks = $derived(
		selectedId === null
			? []
			: links
					.filter((l) => l.source_id === selectedId || l.target_id === selectedId)
					.map((l) => {
						const otherId = l.source_id === selectedId ? l.target_id : l.source_id;
						return { linkId: l.id, other: nodeById.get(otherId), label: l.label };
					})
					.filter((l) => l.other)
	);

	// ── Image attachments ────────────────────────────────────────────
	async function insertImage(file: File) {
		const fd = new FormData();
		fd.set('file', file);
		const res = await fetch('/api/notes/attachments', { method: 'POST', body: fd });
		if (!res.ok) {
			panelError = 'Image upload failed.';
			return;
		}
		const { url } = await res.json();
		const markdown = `![](${url})`;
		if (bodyTextareaEl) {
			const start = bodyTextareaEl.selectionStart ?? panelBody.length;
			const end = bodyTextareaEl.selectionEnd ?? panelBody.length;
			panelBody = panelBody.slice(0, start) + markdown + panelBody.slice(end);
		} else {
			panelBody += markdown;
		}
		panelDirty = true;
	}

	function onBodyPaste(e: ClipboardEvent) {
		const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
		if (!item) return;
		e.preventDefault();
		const file = item.getAsFile();
		if (file) insertImage(file);
	}

	function onFileInputChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) insertImage(file);
		input.value = '';
	}

	// ── Create note (with templates) ────────────────────────────────
	let newNotePopup = $state<{
		screenX: number;
		screenY: number;
		worldX: number;
		worldY: number;
	} | null>(null);

	async function createNoteAt(worldX: number, worldY: number, title = 'Untitled', body = '') {
		const fd = new FormData();
		fd.set('title', title);
		fd.set('body', body);
		fd.set('x', String(worldX));
		fd.set('y', String(worldY));
		const res = await fetch('/api/notes', { method: 'POST', body: fd });
		if (!res.ok) return;
		const note = await res.json();
		nodes.push({
			id: note.id,
			title: note.title,
			x: worldX,
			y: worldY,
			vx: 0,
			vy: 0,
			tags: note.tags ?? '',
			folder: note.folder ?? '',
			updated_at: note.updated_at
		});
		wake();
		selectNote(note.id);
	}

	function pickTemplate(tpl: (typeof TEMPLATES)[number]) {
		if (!newNotePopup) return;
		createNoteAt(newNotePopup.worldX, newNotePopup.worldY, tpl.name, tpl.body);
		newNotePopup = null;
	}

	function openNewNoteAtCenter() {
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const w = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
		newNotePopup = { screenX: rect.width / 2, screenY: rect.height / 2, worldX: w.x, worldY: w.y };
	}

	// ── Drag / link / path / box-select interaction ─────────────────
	let draggingId = $state<number | null>(null);
	let dragMoved = false;
	let linkingFrom = $state<number | null>(null);
	let linkCursor = $state<{ x: number; y: number } | null>(null);
	let panning = false;
	let lastPointer = { x: 0, y: 0 };
	let pathStart = $state<number | null>(null);
	let pathLinkIds = $state<Set<number>>(new Set());
	let multiSelected = $state<Set<number>>(new Set());
	let armBulkLinkHub = $state(false);
	let boxSelect = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

	function toWorld(clientX: number, clientY: number) {
		const rect = canvasEl.getBoundingClientRect();
		return {
			x: (clientX - rect.left - viewX) / zoom,
			y: (clientY - rect.top - viewY) / zoom
		};
	}

	function bfsPath(startId: number, endId: number): number[] {
		const adjacency = new Map<number, { to: number; linkId: number }[]>();
		for (const l of links) {
			if (!adjacency.has(l.source_id)) adjacency.set(l.source_id, []);
			if (!adjacency.has(l.target_id)) adjacency.set(l.target_id, []);
			adjacency.get(l.source_id)!.push({ to: l.target_id, linkId: l.id });
			adjacency.get(l.target_id)!.push({ to: l.source_id, linkId: l.id });
		}
		const prev = new Map<number, { from: number; linkId: number }>();
		const visited = new Set([startId]);
		const queue = [startId];
		while (queue.length) {
			const cur = queue.shift()!;
			if (cur === endId) break;
			for (const edge of adjacency.get(cur) ?? []) {
				if (!visited.has(edge.to)) {
					visited.add(edge.to);
					prev.set(edge.to, { from: cur, linkId: edge.linkId });
					queue.push(edge.to);
				}
			}
		}
		if (!visited.has(endId)) return [];
		const result: number[] = [];
		let cur = endId;
		while (cur !== startId) {
			const p = prev.get(cur);
			if (!p) break;
			result.push(p.linkId);
			cur = p.from;
		}
		return result;
	}

	function handlePathClick(id: number) {
		if (pathStart === null) {
			pathStart = id;
			pathLinkIds = new Set();
			return;
		}
		if (pathStart === id) {
			pathStart = null;
			pathLinkIds = new Set();
			return;
		}
		pathLinkIds = new Set(bfsPath(pathStart, id));
		pathStart = null;
	}

	async function linkSelectedTo(hubId: number) {
		const ids = [...multiSelected].filter((id) => id !== hubId);
		multiSelected = new Set();
		for (const id of ids) {
			const fd = new FormData();
			fd.set('a', String(id));
			fd.set('b', String(hubId));
			const res = await fetch('/notes?/link', { method: 'POST', body: fd });
			if (res.ok) {
				const exists = links.some(
					(l) =>
						(l.source_id === id && l.target_id === hubId) ||
						(l.source_id === hubId && l.target_id === id)
				);
				if (!exists) {
					links.push({
						id: -Date.now() - id,
						source_id: Math.min(id, hubId),
						target_id: Math.max(id, hubId),
						label: null,
						directed: 0
					});
				}
			}
		}
		wake();
	}

	function onNodePointerDown(e: PointerEvent, id: number) {
		e.stopPropagation();
		const active = effectiveTool(e);
		if (active === 'link') {
			// Deliberately no setPointerCapture here: capturing would route the
			// eventual pointerup back to this (source) node instead of whichever
			// node the pointer is released over, breaking link creation.
			linkingFrom = id;
			linkCursor = toWorld(e.clientX, e.clientY);
		} else if (active === 'path') {
			// handled entirely on pointerup
		} else {
			// 'default' and 'select' both drag the node; 'select' just also
			// toggles membership on release if the pointer never actually moved.
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			draggingId = id;
			dragMoved = false;
		}
	}

	function onNodePointerUp(e: PointerEvent, id: number) {
		const active = effectiveTool(e);
		if (linkingFrom !== null && linkingFrom !== id) {
			const fromId = linkingFrom;
			const label = window.prompt('Label this connection (optional):', '') ?? '';
			const directed = window.confirm(
				'Make this a directional link (arrow from the first note to the second)?'
			);
			const fd = new FormData();
			fd.set('a', String(fromId));
			fd.set('b', String(id));
			if (label.trim()) fd.set('label', label.trim());
			if (directed) fd.set('directed', '1');
			fetch('/notes?/link', { method: 'POST', body: fd }).then((res) => {
				if (!res.ok) return;
				const exists = links.some(
					(l) =>
						(l.source_id === fromId && l.target_id === id) ||
						(l.source_id === id && l.target_id === fromId)
				);
				if (!exists) {
					const [source_id, target_id] = directed ? [fromId, id] : [Math.min(fromId, id), Math.max(fromId, id)];
					links.push({
						id: -Date.now(),
						source_id,
						target_id,
						label: label.trim() || null,
						directed: directed ? 1 : 0
					});
					wake();
				}
			});
		} else if (active === 'path') {
			handlePathClick(id);
		} else if (!dragMoved) {
			if (active === 'select') {
				const next = new Set(multiSelected);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				multiSelected = next;
			} else if (armBulkLinkHub && multiSelected.size > 0 && !multiSelected.has(id)) {
				linkSelectedTo(id);
				armBulkLinkHub = false;
			} else {
				selectNote(id);
			}
		}
		linkingFrom = null;
		linkCursor = null;
		draggingId = null;
	}

	function onCanvasPointerDown(e: PointerEvent) {
		if (newNotePopup) {
			newNotePopup = null;
			return;
		}
		if (e.button !== 0) return;
		if (effectiveTool(e) === 'select') {
			const rect = canvasEl.getBoundingClientRect();
			boxSelect = {
				x0: e.clientX - rect.left,
				y0: e.clientY - rect.top,
				x1: e.clientX - rect.left,
				y1: e.clientY - rect.top
			};
			return;
		}
		panning = true;
		lastPointer = { x: e.clientX, y: e.clientY };
	}

	function onCanvasPointerMove(e: PointerEvent) {
		if (boxSelect) {
			const rect = canvasEl.getBoundingClientRect();
			boxSelect = { ...boxSelect, x1: e.clientX - rect.left, y1: e.clientY - rect.top };
			return;
		}
		if (draggingId !== null) {
			dragMoved = true;
			const node = nodeById.get(draggingId);
			if (node) {
				const w = toWorld(e.clientX, e.clientY);
				node.x = w.x;
				node.y = w.y;
				node.vx = 0;
				node.vy = 0;
			}
			return;
		}
		if (linkingFrom !== null) {
			linkCursor = toWorld(e.clientX, e.clientY);
			return;
		}
		if (panning) {
			viewX += e.clientX - lastPointer.x;
			viewY += e.clientY - lastPointer.y;
			lastPointer = { x: e.clientX, y: e.clientY };
		}
	}

	function onCanvasPointerUp() {
		if (boxSelect) {
			const { x0, y0, x1, y1 } = boxSelect;
			const minX = Math.min(x0, x1),
				maxX = Math.max(x0, x1);
			const minY = Math.min(y0, y1),
				maxY = Math.max(y0, y1);
			const picked = new Set<number>();
			for (const n of nodes) {
				const sx = viewX + n.x * zoom;
				const sy = viewY + n.y * zoom;
				if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) picked.add(n.id);
			}
			multiSelected = new Set([...multiSelected, ...picked]);
			boxSelect = null;
			return;
		}
		if (draggingId !== null) {
			const node = nodeById.get(draggingId);
			if (node) saveMove(node);
		}
		panning = false;
		draggingId = null;
		linkingFrom = null;
		linkCursor = null;
	}

	function onCanvasDblClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('[data-note-id]')) return;
		const rect = canvasEl.getBoundingClientRect();
		const w = toWorld(e.clientX, e.clientY);
		newNotePopup = {
			screenX: e.clientX - rect.left,
			screenY: e.clientY - rect.top,
			worldX: w.x,
			worldY: w.y
		};
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const rect = canvasEl.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		const worldX = (cx - viewX) / zoom;
		const worldY = (cy - viewY) / zoom;
		const next = Math.min(2.5, Math.max(0.25, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
		zoom = next;
		viewX = cx - worldX * zoom;
		viewY = cy - worldY * zoom;
	}

	// ── Force simulation ────────────────────────────────────────────
	let simRunning = false;
	const savePending = new Map<number, ReturnType<typeof setTimeout>>();

	function saveMove(node: SimNode) {
		const existing = savePending.get(node.id);
		if (existing) clearTimeout(existing);
		savePending.set(
			node.id,
			setTimeout(() => {
				savePending.delete(node.id);
				const fd = new FormData();
				fd.set('id', String(node.id));
				fd.set('x', String(node.x));
				fd.set('y', String(node.y));
				fetch('/notes?/move', { method: 'POST', body: fd });
			}, 400)
		);
	}

	function wake() {
		if (simRunning) return;
		simRunning = true;
		requestAnimationFrame(tick);
	}

	function tick() {
		let maxSpeed = 0;

		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i];
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let dist = Math.hypot(dx, dy) || 0.01;
				if (dist < MIN_DIST) dist = MIN_DIST;
				const force = REPEL / (dist * dist);
				dx /= dist;
				dy /= dist;
				a.vx += dx * force;
				a.vy += dy * force;
				b.vx -= dx * force;
				b.vy -= dy * force;
			}
		}

		for (const l of links) {
			const a = nodeById.get(l.source_id);
			const b = nodeById.get(l.target_id);
			if (!a || !b) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.hypot(dx, dy) || 0.01;
			const force = (dist - LINK_DISTANCE) * LINK_STRENGTH;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.vx += fx;
			a.vy += fy;
			b.vx -= fx;
			b.vy -= fy;
		}

		for (const n of nodes) {
			if (n.id === draggingId) continue;
			n.vx += -n.x * CENTER_STRENGTH;
			n.vy += -n.y * CENTER_STRENGTH;
			n.vx *= DAMPING;
			n.vy *= DAMPING;
			n.x += n.vx;
			n.y += n.vy;
			const speed = Math.hypot(n.vx, n.vy);
			if (speed > maxSpeed) maxSpeed = speed;
			if (speed > 0.05) saveMove(n);
		}
		nodes = nodes;

		if (maxSpeed > SETTLE_EPS || draggingId !== null) {
			requestAnimationFrame(tick);
		} else {
			simRunning = false;
		}
	}

	$effect(() => {
		if (isMobile) return;
		centerView();
		wake();
	});

	// ── Command palette ──────────────────────────────────────────────
	let paletteOpen = $state(false);
	let paletteQuery = $state('');
	let paletteInputEl: HTMLInputElement | undefined = $state();
	function openPalette() {
		paletteOpen = true;
		paletteQuery = '';
		queueMicrotask(() => paletteInputEl?.focus());
	}
	function closePalette() {
		paletteOpen = false;
	}
	function palettePickNote(id: number) {
		focusNode(id);
		closePalette();
	}
	function paletteCreateNote() {
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const w = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
		createNoteAt(w.x, w.y);
		closePalette();
	}

	$effect(() => {
		if (!browser) return;
		function onKeydown(e: KeyboardEvent) {
			if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				paletteOpen ? closePalette() : openPalette();
				return;
			}
			if (e.key === 'Escape') {
				if (paletteOpen) {
					closePalette();
					return;
				}
				if (selectedId !== null) {
					closePanel();
					return;
				}
				multiSelected = new Set();
				armBulkLinkHub = false;
				pathStart = null;
				pathLinkIds = new Set();
				newNotePopup = null;
				tool = 'default';
			}
		}
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	// ── Saved views ──────────────────────────────────────────────────
	type SavedView = {
		name: string;
		viewX: number;
		viewY: number;
		zoom: number;
		tagFilter: string | null;
		folderFilter: string | null;
	};
	let savedViews = $state<SavedView[]>([]);
	$effect(() => {
		if (!browser) return;
		try {
			savedViews = JSON.parse(localStorage.getItem('notes-views') ?? '[]');
		} catch {
			savedViews = [];
		}
	});
	function persistViews() {
		if (browser) localStorage.setItem('notes-views', JSON.stringify(savedViews));
	}
	function saveCurrentView() {
		const name = window.prompt('Name this view:');
		if (!name || !name.trim()) return;
		const view: SavedView = { name: name.trim(), viewX, viewY, zoom, tagFilter, folderFilter };
		savedViews = [...savedViews.filter((v) => v.name !== view.name), view];
		persistViews();
	}
	function jumpToView(view: SavedView) {
		viewX = view.viewX;
		viewY = view.viewY;
		zoom = view.zoom;
		tagFilter = view.tagFilter;
		folderFilter = view.folderFilter;
	}
	function deleteView(name: string, e: MouseEvent) {
		e.stopPropagation();
		savedViews = savedViews.filter((v) => v.name !== name);
		persistViews();
	}

	// ── Export ───────────────────────────────────────────────────────
	function exportGraphJson() {
		const payload = { exportedAt: new Date().toISOString(), notes: nodes, links };
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `notes-graph-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// ── Markdown toolbar ─────────────────────────────────────────────
	function wrapSelection(before: string, after: string = before) {
		if (!bodyTextareaEl) return;
		const start = bodyTextareaEl.selectionStart;
		const end = bodyTextareaEl.selectionEnd;
		const selected = panelBody.slice(start, end);
		panelBody = panelBody.slice(0, start) + before + selected + after + panelBody.slice(end);
		panelDirty = true;
		const el = bodyTextareaEl;
		queueMicrotask(() => {
			el.focus();
			el.setSelectionRange(start + before.length, start + before.length + selected.length);
		});
	}
	function insertAtCursor(text: string) {
		if (!bodyTextareaEl) {
			panelBody += text;
			panelDirty = true;
			return;
		}
		const start = bodyTextareaEl.selectionStart ?? panelBody.length;
		const end = bodyTextareaEl.selectionEnd ?? panelBody.length;
		panelBody = panelBody.slice(0, start) + text + panelBody.slice(end);
		panelDirty = true;
	}

	const filteredList = $derived(
		[...nodes]
			.filter((n) => !tagFilter || splitTags(n.tags).includes(tagFilter))
			.filter((n) => !folderFilter || n.folder.trim() === folderFilter)
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
	);
	// Pre-fills from ?q= so the /newtab dashboard's "!notes" bang can link
	// straight into a search rather than just the bare notes list.
	let search = $state(page.url.searchParams.get('q') ?? '');
	let searchResults = $state<{ id: number; title: string; updated_at: string }[] | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const q = search.trim();
		clearTimeout(searchTimer);
		if (!q) {
			searchResults = null;
			return;
		}
		searchTimer = setTimeout(async () => {
			const res = await fetch(`/api/notes/search?q=${encodeURIComponent(q)}`);
			if (res.ok) searchResults = await res.json();
		}, 250);
		return () => clearTimeout(searchTimer);
	});

	const searchedList = $derived.by(() => {
		const q = search.trim();
		if (!q) return filteredList;
		if (searchResults) {
			return searchResults.map((r) => nodeById.get(r.id)).filter((n): n is SimNode => !!n);
		}
		// instant fallback shown while the debounced server search is in flight
		return filteredList.filter((n) => n.title.toLowerCase().includes(q.toLowerCase()));
	});

	const paletteMatches = $derived(
		(paletteQuery.trim()
			? nodes.filter((n) => n.title.toLowerCase().includes(paletteQuery.trim().toLowerCase()))
			: filteredList
		).slice(0, 8)
	);

	function focusNode(id: number) {
		const node = nodeById.get(id);
		if (!node || !canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		viewX = rect.width / 2 - node.x * zoom;
		viewY = rect.height / 2 - node.y * zoom;
		selectNote(id);
	}
</script>

<Seo title="Notes — RazerGhost" description="Private notes." path="/notes" noindex />

<main class="{isMobile ? 'flex' : 'hidden'} h-[100dvh] w-full flex-col overflow-hidden bg-bg">
		{#if selectedId === null}
			<!-- List view -->
			<header class="flex items-center justify-between border-b border-border px-4 py-3">
				<a href="/" class="link flex items-center gap-1.5 text-xs text-dim hover:text-primary">
					<Logo variant="outline" size={16} />
					RazerGhost
				</a>
				<ThemeToggle />
			</header>
			<div class="border-b border-border p-3">
				<input
					type="text"
					bind:value={search}
					placeholder="Search notes…"
					class="input w-full rounded-md border border-border bg-transparent px-3 py-2 text-base text-white placeholder:text-dim"
				/>
			</div>
			<ul class="flex-1 overflow-y-auto">
				{#each searchedList as note (note.id)}
					<li class="border-b border-border">
						<button
							type="button"
							onclick={() => selectNote(note.id)}
							class="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left active:bg-surface-2"
						>
							<span class="truncate text-base font-medium text-white">{note.title || 'Untitled'}</span>
							<span class="text-xs text-dim">{new Date(note.updated_at).toLocaleDateString()}</span>
						</button>
					</li>
				{:else}
					<li class="px-4 py-10 text-center text-sm text-dim">No notes yet — tap + to write one.</li>
				{/each}
			</ul>
			<button
				type="button"
				onclick={() => createNoteAt(0, 0)}
				aria-label="New note"
				class="fixed bottom-6 right-6 grid h-14 w-14 place-items-center rounded-full border border-primary bg-surface text-3xl leading-none text-primary shadow-lg active:bg-primary/10"
			>
				+
			</button>
		{:else}
			<!-- Full-screen editor -->
			<header class="flex items-center justify-between border-b border-border px-3 py-2">
				<button type="button" onclick={mobileBack} class="text-sm text-dim hover:text-white">
					← Back
				</button>
				<span class="text-[11px] text-dim">
					{#if panelSaving}Saving…{:else if !panelDirty}Saved{/if}
				</span>
				<button type="button" onclick={deleteSelected} class="text-xs text-dim hover:text-red-400">
					Delete
				</button>
			</header>
			{#if loadingNote}
				<p class="p-4 text-sm text-dim">Loading…</p>
			{:else if panelError}
				<p class="p-4 text-sm text-red-400">{panelError}</p>
			{:else}
				<input
					type="text"
					bind:value={panelTitle}
					oninput={() => (panelDirty = true)}
					placeholder="Title"
					class="border-b border-border bg-transparent px-4 py-3 text-lg font-semibold text-white placeholder:text-dim focus:outline-none"
				/>
				<input
					type="text"
					bind:value={panelTags}
					oninput={() => (panelDirty = true)}
					placeholder="Tags, comma-separated"
					class="border-b border-border bg-transparent px-4 py-2 text-sm text-white placeholder:text-dim focus:outline-none"
				/>
				<div class="flex items-center justify-between border-b border-border px-3 py-1.5">
					<div class="flex gap-1 text-xs">
						<button
							type="button"
							onclick={() => (panelMode = 'write')}
							class="rounded-full px-3 py-1 transition-colors {panelMode === 'write'
								? 'bg-primary/10 text-primary'
								: 'text-dim hover:text-white'}"
						>
							Write
						</button>
						<button
							type="button"
							onclick={() => (panelMode = 'preview')}
							class="rounded-full px-3 py-1 transition-colors {panelMode === 'preview'
								? 'bg-primary/10 text-primary'
								: 'text-dim hover:text-white'}"
						>
							Preview
						</button>
					</div>
					<label
						class="link cursor-pointer rounded-full border border-border px-3 py-1 text-xs text-dim hover:border-primary hover:text-primary"
					>
						Add image
						<input type="file" accept="image/*" class="hidden" onchange={onFileInputChange} />
					</label>
				</div>
				{#if panelMode === 'preview'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<div
						role="group"
						aria-label="Note preview"
						onclick={onPreviewClick}
						class="devlog-content flex-1 overflow-y-auto px-4 py-3"
					>
						{@html previewHtml}
					</div>
				{:else}
					<textarea
						bind:this={bodyTextareaEl}
						bind:value={panelBody}
						oninput={() => (panelDirty = true)}
						onpaste={onBodyPaste}
						placeholder="Write something… (type [[Note Title]] to link)"
						class="flex-1 resize-none bg-transparent px-4 py-3 text-base text-white placeholder:text-dim focus:outline-none"
					></textarea>
				{/if}
			{/if}
		{/if}
	</main>
<main class="{isMobile ? 'hidden' : 'flex'} h-screen w-full overflow-hidden">
	<!-- Sidebar -->
	<aside class="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40">
		<div class="flex items-center justify-between border-b border-border px-3 py-2">
			<a
				href="/"
				class="link flex items-center gap-1.5 text-xs text-dim hover:text-primary"
				title="Back to RazerGhost"
			>
				<Logo variant="outline" size={16} />
				RazerGhost
			</a>
			<div class="flex items-center gap-2">
				<a
					href="/admin"
					class="link flex items-center gap-1 text-dim hover:text-primary"
					title="Admin tools"
				>
					<LayoutGrid size={16} />
				</a>
				<ThemeToggle />
			</div>
		</div>
		<div class="border-b border-border p-3">
			<input
				type="text"
				bind:value={search}
				placeholder="Search notes…"
				class="input w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm text-white placeholder:text-dim"
			/>
		</div>

		{#if recentNotes.length > 0}
			<div class="flex flex-wrap gap-1 border-b border-border p-2">
				{#each recentNotes as note (note.id)}
					<button
						type="button"
						onclick={() => focusNode(note.id)}
						class="max-w-[7rem] truncate rounded-full border border-border px-2 py-0.5 text-[11px] text-dim hover:border-primary hover:text-primary"
						title={note.title}
					>
						{note.title || 'Untitled'}
					</button>
				{/each}
			</div>
		{/if}

		{#if allTags.length > 0}
			<div class="flex flex-wrap gap-1 border-b border-border p-2">
				{#each allTags as tag (tag)}
					<button
						type="button"
						onclick={() => (tagFilter = tagFilter === tag ? null : tag)}
						class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors {tagFilter ===
						tag
							? 'border-primary text-primary'
							: 'border-border text-dim hover:text-white'}"
					>
						<span class="h-1.5 w-1.5 rounded-full" style="background:{tagColor(tag)}"></span>
						{tag}
					</button>
				{/each}
			</div>
		{/if}

		{#if allFolders.length > 0}
			<div class="flex flex-wrap gap-1 border-b border-border p-2">
				{#each allFolders as folder (folder)}
					<button
						type="button"
						onclick={() => (folderFilter = folderFilter === folder ? null : folder)}
						class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {folderFilter ===
						folder
							? 'border-primary text-primary'
							: 'border-border text-dim hover:text-white'}"
					>
						📁 {folder}
					</button>
				{/each}
			</div>
		{/if}

		<div class="flex items-center justify-between border-b border-border px-3 py-2">
			<span class="text-[11px] text-dim">Dim unconnected</span>
			<button
				type="button"
				onclick={() => (dimOrphans = !dimOrphans)}
				class="rounded-full border px-2 py-0.5 text-[11px] transition-colors {dimOrphans
					? 'border-primary text-primary'
					: 'border-border text-dim hover:text-white'}"
			>
				{dimOrphans ? 'On' : 'Off'}
			</button>
		</div>

		<div class="border-b border-border p-2">
			<div class="flex items-center justify-between px-1">
				<span class="text-[11px] uppercase tracking-wide text-dim">Views</span>
				<button type="button" onclick={saveCurrentView} class="text-[11px] text-primary hover:opacity-80">
					+ Save current
				</button>
			</div>
			{#if savedViews.length > 0}
				<ul class="mt-1 flex flex-col gap-0.5">
					{#each savedViews as view (view.name)}
						<li>
							<button
								type="button"
								onclick={() => jumpToView(view)}
								class="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs text-gray hover:bg-surface-2 hover:text-white"
							>
								<span class="truncate">{view.name}</span>
								<span
									role="button"
									tabindex="0"
									onclick={(e) => deleteView(view.name, e)}
									onkeydown={(e) => e.key === 'Enter' && deleteView(view.name, e as unknown as MouseEvent)}
									class="shrink-0 text-dim hover:text-red-400"
								>
									✕
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<ul class="flex-1 overflow-y-auto p-2">
			{#each searchedList as note (note.id)}
				<li>
					<button
						type="button"
						onclick={() => focusNode(note.id)}
						class="w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors {selectedId ===
						note.id
							? 'bg-primary/10 text-primary'
							: 'text-gray hover:bg-surface-2 hover:text-white'}"
					>
						{note.title || 'Untitled'}
					</button>
				</li>
			{:else}
				<li class="px-2 py-4 text-xs text-dim">No notes match.</li>
			{/each}
		</ul>
		<div class="flex items-center justify-between border-t border-border p-2">
			<button
				type="button"
				onclick={openPalette}
				class="rounded-full border border-border px-2 py-1 text-[11px] text-dim hover:border-primary hover:text-primary"
			>
				Ctrl+K search
			</button>
			<button
				type="button"
				onclick={exportGraphJson}
				class="rounded-full border border-border px-2 py-1 text-[11px] text-dim hover:border-primary hover:text-primary"
			>
				Export JSON
			</button>
		</div>
	</aside>

	{#if paletteOpen}
		<div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24">
			<button
				type="button"
				aria-label="Close command palette"
				onclick={closePalette}
				class="absolute inset-0 cursor-default"
			></button>
			<div
				role="dialog"
				aria-label="Command palette"
				tabindex="-1"
				onpointerdown={(e) => e.stopPropagation()}
				class="relative flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
			>
				<input
					bind:this={paletteInputEl}
					type="text"
					bind:value={paletteQuery}
					placeholder="Jump to a note…"
					class="border-b border-border bg-transparent px-4 py-3 text-white placeholder:text-dim focus:outline-none"
				/>
				<ul class="max-h-80 overflow-y-auto p-2">
					<li class="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wide text-dim">Notes</li>
					{#each paletteMatches as note (note.id)}
						<li>
							<button
								type="button"
								onclick={() => palettePickNote(note.id)}
								class="w-full truncate rounded-md px-3 py-2 text-left text-sm text-gray hover:bg-surface-2 hover:text-white"
							>
								{note.title || 'Untitled'}
							</button>
						</li>
					{:else}
						<li class="px-3 py-2 text-xs text-dim">No matches.</li>
					{/each}

					<li class="mt-2 border-t border-border pt-1">
						<a
							href="/admin"
							onclick={closePalette}
							class="link block w-full rounded-md px-3 py-2 text-left text-sm text-gray hover:bg-surface-2 hover:text-white"
						>
							Admin tools →
						</a>
					</li>

					<li class="mt-1 border-t border-border pt-1">
						<button
							type="button"
							onclick={paletteCreateNote}
							class="w-full rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-surface-2"
						>
							+ New note
						</button>
					</li>
				</ul>
			</div>
		</div>
	{/if}

	<!-- Canvas -->
	<div
		bind:this={canvasEl}
		role="application"
		aria-label="Notes graph canvas"
		class="relative flex-1 touch-none overflow-hidden bg-bg"
		style="background-image: radial-gradient(var(--border) 1px, transparent 1px); background-size: 28px 28px; background-position: {viewX}px {viewY}px;"
		onpointerdown={onCanvasPointerDown}
		onpointermove={onCanvasPointerMove}
		onpointerup={onCanvasPointerUp}
		onpointerleave={onCanvasPointerUp}
		ondblclick={onCanvasDblClick}
		onwheel={onWheel}
	>
		{#if multiSelected.size > 0}
			<div
				class="pointer-events-auto absolute left-1/2 top-14 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--color-action)] bg-surface/90 px-4 py-1.5 text-xs text-white"
			>
				<span>{multiSelected.size} selected</span>
				{#if armBulkLinkHub}
					<span class="text-[var(--color-action)]">Click a note to link them all…</span>
				{:else}
					<button
						type="button"
						onclick={() => (armBulkLinkHub = true)}
						class="link text-primary hover:opacity-80"
					>
						Link to next click
					</button>
				{/if}
				<button
					type="button"
					onclick={() => {
						multiSelected = new Set();
						armBulkLinkHub = false;
					}}
					class="text-dim hover:text-white"
				>
					Clear
				</button>
			</div>
		{/if}

		<div
			class="absolute left-0 top-0"
			style="transform: translate({viewX}px, {viewY}px) scale({zoom}); transform-origin: 0 0;"
		>
			<svg class="pointer-events-none absolute overflow-visible" style="left:0; top:0;">
				<defs>
					<marker
						id="link-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth={6 / zoom}
						markerHeight={6 / zoom}
						orient="auto-start-reverse"
					>
						<path d="M0,0 L10,5 L0,10 z" fill="var(--primary-glow-border)" />
					</marker>
				</defs>
				{#each links as l (l.id)}
					{@const a = nodeById.get(l.source_id)}
					{@const b = nodeById.get(l.target_id)}
					{#if a && b}
						<line
							x1={a.x}
							y1={a.y}
							x2={b.x}
							y2={b.y}
							stroke={pathLinkIds.has(l.id) ? 'var(--color-action)' : 'var(--primary-glow-border)'}
							stroke-width={(pathLinkIds.has(l.id) ? 3 : 1.5) / zoom}
							marker-end={l.directed ? 'url(#link-arrow)' : undefined}
						/>
						{#if l.label}
							<text
								x={(a.x + b.x) / 2}
								y={(a.y + b.y) / 2}
								fill="var(--dim)"
								font-size={11 / zoom}
								text-anchor="middle"
							>
								{l.label}
							</text>
						{/if}
					{/if}
				{/each}
				{#if linkingFrom !== null && linkCursor}
					{@const a = nodeById.get(linkingFrom)}
					{#if a}
						<line
							x1={a.x}
							y1={a.y}
							x2={linkCursor.x}
							y2={linkCursor.y}
							stroke="var(--color-action)"
							stroke-width={2 / zoom}
							stroke-dasharray="4 4"
						/>
					{/if}
				{/if}
			</svg>

			{#each clusters as cluster (cluster.key)}
				<button
					type="button"
					onclick={() => renameCluster(cluster)}
					class="pointer-events-auto absolute whitespace-nowrap rounded-full border border-border/60 bg-surface/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-dim hover:border-primary hover:text-primary"
					style="left:{cluster.x}px; top:{cluster.y - radiusFor(cluster.ids[0]) - 18}px; transform: translate(-50%, -50%) scale({1 / zoom});"
				>
					{clusterLabel(cluster)}
				</button>
			{/each}

			{#each nodes as node (node.id)}
				{@const r = radiusFor(node.id)}
				<button
					type="button"
					data-note-id={node.id}
					onpointerdown={(e) => onNodePointerDown(e, node.id)}
					onpointerup={(e) => onNodePointerUp(e, node.id)}
					class="group absolute flex select-none items-center justify-center rounded-full border text-center transition-shadow {selectedId ===
					node.id
						? 'border-[var(--color-action)] shadow-[0_0_0_3px_var(--action-glow)]'
						: multiSelected.has(node.id)
							? 'border-[var(--color-action)] shadow-[0_0_0_2px_var(--action-glow)]'
							: pathStart === node.id
								? 'border-[var(--color-action)]'
								: 'border-[var(--primary-glow-border)] hover:shadow-[0_0_20px_var(--primary-glow)]'}"
					style="left:{node.x}px; top:{node.y}px; width:{r * 2}px; height:{r * 2}px; margin:-{r}px;
						opacity:{nodeOpacity(node.id)};
						background: radial-gradient(circle at 35% 30%, var(--surface-2), var(--surface));
						cursor: {draggingId === node.id ? 'grabbing' : 'grab'};"
				>
					{#if splitTags(node.tags).length > 0}
						<span
							class="pointer-events-none absolute -top-1 right-1 h-2 w-2 rounded-full"
							style="background:{tagColor(splitTags(node.tags)[0])}"
						></span>
					{/if}
					<span class="pointer-events-none max-w-full truncate px-2 text-[11px] font-medium text-white">
						{node.title || 'Untitled'}
					</span>
				</button>
			{/each}
		</div>

		{#if newNotePopup}
			<div
				role="menu"
				tabindex="-1"
				onpointerdown={(e) => e.stopPropagation()}
				class="absolute z-20 flex flex-col gap-1 rounded-lg border border-border bg-surface p-2 shadow-lg"
				style="left:{newNotePopup.screenX}px; top:{newNotePopup.screenY}px;"
			>
				{#each TEMPLATES as tpl (tpl.name)}
					<button
						type="button"
						onclick={() => pickTemplate(tpl)}
						class="rounded-md px-3 py-1.5 text-left text-sm text-gray hover:bg-surface-2 hover:text-white"
					>
						{tpl.name}
					</button>
				{/each}
			</div>
		{/if}

		{#if boxSelect}
			<div
				class="pointer-events-none absolute border border-[var(--color-action)] bg-[var(--action-glow)]"
				style="left:{Math.min(boxSelect.x0, boxSelect.x1)}px; top:{Math.min(
					boxSelect.y0,
					boxSelect.y1
				)}px; width:{Math.abs(boxSelect.x1 - boxSelect.x0)}px; height:{Math.abs(
					boxSelect.y1 - boxSelect.y0
				)}px;"
			></div>
		{/if}

		{#if nodes.length > 0}
			{@const vp = minimapViewport()}
			<button
				type="button"
				onclick={onMinimapClick}
				aria-label="Minimap — click to jump"
				class="absolute bottom-3 right-3 overflow-hidden rounded-md border border-border bg-surface/80"
				style="width:{MINIMAP_W}px; height:{MINIMAP_H}px;"
			>
				{#each nodes as node (node.id)}
					{@const p = minimapPoint(node.x, node.y)}
					<span
						class="absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-primary)]"
						style="left:{p.x}px; top:{p.y}px;"
					></span>
				{/each}
				<span
					class="pointer-events-none absolute border border-[var(--color-action)]"
					style="left:{vp.x}px; top:{vp.y}px; width:{vp.w}px; height:{vp.h}px;"
				></span>
			</button>
		{/if}
	</div>

	<!-- Control dock: sits outside the canvas so it centers on the whole
	     screen (sidebar + canvas + detail panel) instead of just the
	     canvas's own — narrower and shifting — width. -->
	<div
		class="pointer-events-none fixed bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface/90 p-1"
	>
		{#each TOOLS as t (t.id)}
			<button
				type="button"
				use:tooltip={t.hint}
				onclick={() => (tool = tool === t.id ? 'default' : t.id)}
				class="pointer-events-auto rounded-full px-3 py-1 text-xs font-medium transition-colors {tool ===
				t.id
					? 'bg-primary/20 text-primary'
					: 'text-dim hover:text-white'}"
			>
				{t.label}
			</button>
		{/each}
		<span class="mx-1 h-4 w-px bg-border"></span>
		<button
			type="button"
			use:tooltip={'Add a note at the center of the view'}
			onclick={openNewNoteAtCenter}
			class="pointer-events-auto rounded-full px-3 py-1 text-xs font-medium text-dim hover:text-white"
		>
			+ Note
		</button>
		<span class="mx-1 h-4 w-px bg-border"></span>
		<span class="px-2 text-xs text-dim">{Math.round(zoom * 100)}%</span>
		<button
			type="button"
			onclick={fitToView}
			class="pointer-events-auto rounded-full px-3 py-1 text-xs font-medium text-dim hover:text-white"
		>
			Fit view
		</button>
		<span class="mx-1 h-4 w-px bg-border"></span>
		<button
			type="button"
			use:tooltip={'Use the dock to switch modes: Link, Path, or Select. Pointer mode drags notes and pans the canvas. Holding shift/ctrl/alt while dragging works as a shortcut too. Type [[Note Title]] in a body to auto-link it.'}
			aria-label="Dock help"
			class="pointer-events-auto grid h-6 w-6 place-items-center rounded-full text-dim hover:text-white"
		>
			<CircleHelp size={14} aria-hidden="true" />
		</button>
	</div>

	<!-- Detail panel -->
	{#if selectedId !== null}
		<div
			class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
			onclick={closePanel}
			role="presentation"
		>
			<div
				onclick={(e) => e.stopPropagation()}
				role="presentation"
				class="flex h-[75vh] w-[65vw] max-w-4xl flex-col rounded-lg border border-border bg-surface shadow-2xl"
			>
				<div class="flex items-center justify-between border-b border-border p-3">
					{#if panelView === 'edit'}
						<div class="flex gap-1 text-xs">
							<button
								type="button"
								onclick={() => (panelMode = 'write')}
								class="rounded-full px-3 py-1 transition-colors {panelMode === 'write'
									? 'bg-primary/10 text-primary'
									: 'text-dim hover:text-white'}"
							>
								Write
							</button>
							<button
								type="button"
								onclick={() => (panelMode = 'preview')}
								class="rounded-full px-3 py-1 transition-colors {panelMode === 'preview'
									? 'bg-primary/10 text-primary'
									: 'text-dim hover:text-white'}"
							>
								Preview
							</button>
							<button
								type="button"
								onclick={() => (panelMode = 'history')}
								class="rounded-full px-3 py-1 transition-colors {panelMode === 'history'
									? 'bg-primary/10 text-primary'
									: 'text-dim hover:text-white'}"
							>
								History
							</button>
						</div>
					{:else}
						<span class="text-[11px] uppercase tracking-wide text-dim">Viewing</span>
					{/if}
					<div class="flex items-center gap-2">
						{#if panelView === 'edit'}
							{#if panelSaving}
								<span class="text-[11px] text-dim">Saving…</span>
							{:else if !panelDirty}
								<span class="text-[11px] text-dim">Saved</span>
							{/if}
							<button
								type="button"
								onclick={() => (panelView = 'view')}
								class="text-xs text-dim hover:text-white"
							>
								Done
							</button>
							<span class="h-4 w-px bg-border"></span>
						{/if}
						<button type="button" onclick={closePanel} class="text-xs text-dim hover:text-white">
							Close
						</button>
					</div>
				</div>

				<div class="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
					{#if loadingNote}
						<p class="text-sm text-dim">Loading…</p>
					{:else if panelError}
						<p class="text-sm text-red-400">{panelError}</p>
					{:else if panelView === 'view'}
						<h2 class="text-xl font-bold text-white">{panelTitle || 'Untitled'}</h2>
						{#if panelTags || panelFolder}
							<div class="flex flex-wrap gap-3 text-xs text-dim">
								{#if panelFolder}<span>📁 {panelFolder}</span>{/if}
								{#if panelTags}<span>{panelTags}</span>{/if}
							</div>
						{/if}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<div
							role="group"
							aria-label="Note"
							onclick={onPreviewClick}
							class="devlog-content flex-1 overflow-y-auto rounded-lg border border-border px-3 py-2"
						>
							{@html previewHtml}
						</div>

						{#if selectedLinks.length > 0}
							<div class="border-t border-border pt-3">
								<p class="mb-2 text-xs uppercase tracking-wide text-dim">Connected</p>
								<ul class="flex flex-col gap-1">
									{#each selectedLinks as l (l.linkId)}
										<li class="flex items-center justify-between gap-2 text-sm">
											<button
												type="button"
												onclick={() => l.other && focusNode(l.other.id)}
												class="link min-w-0 flex-1 truncate text-left text-gray hover:text-primary"
											>
												{l.other?.title || 'Untitled'}
												{#if l.label}<span class="text-xs text-dim">— {l.label}</span>{/if}
											</button>
										</li>
									{/each}
								</ul>
							</div>
						{/if}

						<div class="flex items-center justify-between border-t border-border pt-3">
							<button
								type="button"
								onclick={() => (panelView = 'edit')}
								class="link rounded-full border border-primary px-4 py-2 text-sm text-primary transition-colors hover:bg-primary/10"
							>
								Edit
							</button>
							<button type="button" onclick={deleteSelected} class="text-xs text-dim hover:text-red-400">
								Delete note
							</button>
						</div>
					{:else}
						<input
							type="text"
							bind:value={panelTitle}
							oninput={() => (panelDirty = true)}
							placeholder="Title"
							class="rounded-lg border border-border bg-transparent px-3 py-2 text-white placeholder:text-dim focus:border-primary focus:outline-none"
						/>
						<div class="flex gap-2">
							<input
								type="text"
								bind:value={panelTags}
								oninput={() => (panelDirty = true)}
								placeholder="Tags, comma-separated"
								class="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-white placeholder:text-dim focus:border-primary focus:outline-none"
							/>
							<input
								type="text"
								bind:value={panelFolder}
								oninput={() => (panelDirty = true)}
								placeholder="Folder"
								class="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-white placeholder:text-dim focus:border-primary focus:outline-none"
							/>
						</div>

						{#if panelMode === 'write'}
						<div class="flex flex-wrap items-center gap-1">
							<button
								type="button"
								title="Bold"
								onclick={() => wrapSelection('**')}
								class="rounded-md border border-border px-2 py-1 text-xs font-bold text-dim hover:border-primary hover:text-primary"
							>
								B
							</button>
							<button
								type="button"
								title="Italic"
								onclick={() => wrapSelection('_')}
								class="rounded-md border border-border px-2 py-1 text-xs italic text-dim hover:border-primary hover:text-primary"
							>
								I
							</button>
							<button
								type="button"
								title="Link"
								onclick={() => wrapSelection('[', '](url)')}
								class="rounded-md border border-border px-2 py-1 text-xs text-dim hover:border-primary hover:text-primary"
							>
								Link
							</button>
							<button
								type="button"
								title="Checklist item"
								onclick={() => insertAtCursor('\n- [ ] ')}
								class="rounded-md border border-border px-2 py-1 text-xs text-dim hover:border-primary hover:text-primary"
							>
								☑ Item
							</button>
							<button
								type="button"
								title="Code block"
								onclick={() => wrapSelection('```\n', '\n```')}
								class="rounded-md border border-border px-2 py-1 font-mono text-xs text-dim hover:border-primary hover:text-primary"
							>
								{'</>'}
							</button>
							<button
								type="button"
								title="Table"
								onclick={() =>
									insertAtCursor('\n| Column | Column |\n| --- | --- |\n| Cell | Cell |\n')}
								class="rounded-md border border-border px-2 py-1 text-xs text-dim hover:border-primary hover:text-primary"
							>
								Table
							</button>
							<label
								class="link ml-auto w-fit cursor-pointer rounded-full border border-border px-3 py-1 text-xs text-dim hover:border-primary hover:text-primary"
							>
								Add image
								<input type="file" accept="image/*" class="hidden" onchange={onFileInputChange} />
							</label>
						</div>
						<textarea
							bind:this={bodyTextareaEl}
							bind:value={panelBody}
							oninput={() => (panelDirty = true)}
							onpaste={onBodyPaste}
							rows="14"
							placeholder="Write something… (paste an image, or type [[Note Title]] to link)"
							class="flex-1 resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-white placeholder:text-dim focus:border-primary focus:outline-none"
						></textarea>
					{:else if panelMode === 'preview'}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<div
							role="group"
							aria-label="Note preview"
							onclick={onPreviewClick}
							class="devlog-content flex-1 overflow-y-auto rounded-lg border border-border px-3 py-2"
						>
							{@html previewHtml}
						</div>
					{:else}
						<div class="flex-1 overflow-y-auto rounded-lg border border-border px-3 py-2">
							{#if revisions.length === 0}
								<p class="text-sm text-dim">No earlier versions yet — they show up here as you edit.</p>
							{:else}
								<ul class="flex flex-col gap-1">
									{#each revisions as rev (rev.id)}
										<li class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
											<div class="min-w-0">
												<p class="truncate text-sm text-white">{rev.title || 'Untitled'}</p>
												<p class="text-[11px] text-dim">{new Date(rev.created_at).toLocaleString()}</p>
											</div>
											<button
												type="button"
												onclick={() => restoreRevision(rev.id)}
												class="shrink-0 text-xs text-primary hover:opacity-80"
											>
												Restore
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}

					{#if selectedLinks.length > 0}
						<div class="border-t border-border pt-3">
							<p class="mb-2 text-xs uppercase tracking-wide text-dim">Connected</p>
							<ul class="flex flex-col gap-1">
								{#each selectedLinks as l (l.linkId)}
									<li class="flex items-center justify-between gap-2 text-sm">
										<button
											type="button"
											onclick={() => l.other && focusNode(l.other.id)}
											class="link min-w-0 flex-1 truncate text-left text-gray hover:text-primary"
										>
											{l.other?.title || 'Untitled'}
											{#if l.label}<span class="text-xs text-dim">— {l.label}</span>{/if}
										</button>
										<button
											type="button"
											onclick={() => relabelLink(l.linkId, l.label)}
											class="shrink-0 text-xs text-dim hover:text-primary"
										>
											Label
										</button>
										<button
											type="button"
											onclick={() => unlink(l.linkId)}
											class="shrink-0 text-xs text-dim hover:text-red-400"
										>
											Unlink
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<div class="flex items-center justify-between border-t border-border pt-3">
						<button
							type="button"
							onclick={() => savePanel()}
							disabled={!panelDirty}
							class="link rounded-full border border-primary px-4 py-2 text-sm text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
						>
							Save
						</button>
						<button type="button" onclick={deleteSelected} class="text-xs text-dim hover:text-red-400">
							Delete note
						</button>
					</div>
				{/if}
			</div>
			</div>
		</div>
	{/if}
</main>

{#if deletedToast}
	<div
		class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm text-white shadow-lg"
	>
		<span>Deleted "{deletedToast.title}"</span>
		<button type="button" onclick={undoDelete} class="link text-primary hover:opacity-80">Undo</button>
	</div>
{/if}
