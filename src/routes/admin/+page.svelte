<script lang="ts">
	import Seo from '$lib/components/Seo.svelte';
	import FileText from '@lucide/svelte/icons/file-text';
	import FolderKanban from '@lucide/svelte/icons/folder-kanban';
	import Activity from '@lucide/svelte/icons/activity';
	import Music from '@lucide/svelte/icons/music';
	import Database from '@lucide/svelte/icons/database';
	import ArchiveRestore from '@lucide/svelte/icons/archive-restore';
	import Image from '@lucide/svelte/icons/image';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';

	const tools = [
		{
			label: 'Devlog editor',
			href: '/admin/devlog',
			icon: FileText,
			description: 'Write and edit posts in src/content/devlog. Commit + push to publish.'
		},
		{
			label: 'Projects editor',
			href: '/admin/projects',
			icon: FolderKanban,
			description: 'Write and edit entries in src/content/projects. Commit + push to publish.'
		},
		{
			label: 'Status editor',
			href: '/admin/status',
			icon: Activity,
			description: 'Edit the "Right now" card shown on the homepage.'
		},
		{
			label: 'Spotify import',
			href: '/spotify-import',
			icon: Music,
			description: 'Upload an extended streaming history export to backfill listening data.'
		},
		{
			label: 'Watchlist cache',
			href: '/admin/watchlist-cache',
			icon: Database,
			description: 'Inspect and force-refresh cached Simkl genre/synopsis/runtime rows.'
		},
		{
			label: 'Backups',
			href: '/admin/backups',
			icon: ArchiveRestore,
			description: 'Check when the data volume last backed up, or trigger one manually.'
		},
		{
			label: 'Media library',
			href: '/admin/media',
			icon: Image,
			description: 'Upload and browse images for devlog/project covers, galleries, and posts.'
		}
	];
</script>

<Seo title="Admin — RazerGhost" description="Private admin dashboard." path="/admin" noindex />

<main class="mx-auto max-w-3xl px-6 py-16">
	<h1 class="text-3xl font-extrabold tracking-tight text-white">Admin</h1>
	<p class="mt-2 text-sm text-dim">Every private tool for editing this site, in one place.</p>

	<ul class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
		{#each tools as tool (tool.href)}
			<li>
				<a
					href={tool.href}
					class="link group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface/40 p-5 transition-colors hover:border-primary"
				>
					<div class="flex items-center justify-between">
						<span
							class="flex h-9 w-9 items-center justify-center rounded-full border border-border text-primary group-hover:border-primary"
						>
							<tool.icon size={18} />
						</span>
						<ArrowUpRight
							size={16}
							class="text-dim opacity-0 transition-opacity group-hover:opacity-100"
						/>
					</div>
					<div>
						<h2 class="font-medium text-white group-hover:text-primary">{tool.label}</h2>
						<p class="mt-1 text-xs text-dim">{tool.description}</p>
					</div>
				</a>
			</li>
		{/each}
	</ul>
</main>
