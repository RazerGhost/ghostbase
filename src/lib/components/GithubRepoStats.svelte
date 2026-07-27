<script lang="ts">
	import Star from '@lucide/svelte/icons/star';

	let { href }: { href?: string } = $props();

	interface RepoStats {
		stars: number;
		language: string | null;
		pushedAt: string;
	}

	let stats = $state<RepoStats | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');

	const repoPath = $derived.by(() => {
		if (!href) return null;
		const match = href.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
		return match ? `${match[1]}/${match[2]}` : null;
	});

	function relativeTime(iso: string): string {
		const diffMs = Date.now() - new Date(iso).getTime();
		const hours = Math.floor(diffMs / 3_600_000);
		if (hours < 1) return 'just now';
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}

	$effect(() => {
		const path = repoPath;
		if (!path) {
			status = 'error';
			return;
		}

		let cancelled = false;
		status = 'loading';

		fetch(`/api/github/repo-stats?repo=${encodeURIComponent(path)}`)
			.then((res) => {
				if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
				return res.json();
			})
			.then((data: RepoStats) => {
				if (cancelled) return;
				stats = data;
				status = 'ready';
			})
			.catch(() => {
				if (!cancelled) status = 'error';
			});

		return () => {
			cancelled = true;
		};
	});
</script>

{#if status === 'ready' && stats}
	<div class="flex items-center gap-3 text-xs text-dim">
		<span class="flex items-center gap-1">
			<Star size={12} aria-hidden="true" />
			{stats.stars}
		</span>
		{#if stats.language}
			<span>{stats.language}</span>
		{/if}
		<span>Updated {relativeTime(stats.pushedAt)}</span>
	</div>
{/if}
