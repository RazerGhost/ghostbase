<script lang="ts">
    import { invalidateAll, replaceState } from "$app/navigation";
    import { page } from "$app/state";
    import { reveal } from "$lib/actions/reveal";
    import Seo from "$lib/components/Seo.svelte";
    import Tv from "@lucide/svelte/icons/tv";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import Star from "@lucide/svelte/icons/star";
    import Shuffle from "@lucide/svelte/icons/shuffle";
    import Play from "@lucide/svelte/icons/play";
    import X from "@lucide/svelte/icons/x";
    import SimklIcon from "@icons-pack/svelte-simple-icons/icons/SiSimkl";
    import MyanimelistIcon from "@icons-pack/svelte-simple-icons/icons/SiMyanimelist";
    import FilmIcon from "@lucide/svelte/icons/film";
    import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
    import { watchProfiles } from "$lib/config";
    import type { Component } from "svelte";
    import type { PageData } from "./$types";
    import type { LibraryItem } from "$lib/server/simkl";

    const profileIcons: Record<(typeof watchProfiles)[number]["icon"], Component<any>> = {
        simkl: SimklIcon,
        mydramalist: FilmIcon,
        myanimelist: MyanimelistIcon
    };

    let { data }: { data: PageData } = $props();

    type SortMode = "added" | "title" | "progress" | "rating";
    type Group = "tv" | "anime";

    const initialParams = page.url.searchParams;
    const initialSortMode: SortMode = (["added", "title", "progress", "rating"] as const).includes(
        initialParams.get("sort") as SortMode,
    )
        ? (initialParams.get("sort") as SortMode)
        : "added";
    const initialGroup: Group = initialParams.get("group") === "anime" ? "anime" : "tv";

    let retrying = $state(false);
    let query = $state(initialParams.get("q") ?? "");
    let sortMode = $state<SortMode>(initialSortMode);
    let selectedGenre = $state<string | null>(initialParams.get("genre"));
    let activeGroup = $state<Group>(initialGroup);
    let pickedItem = $state<LibraryItem | null>(null);
    let spinning = $state(false);

    const PAGE_SIZE = 24;
    type SectionKey = "watching" | "onHold" | "completed" | "dropped" | "planToWatch";
    let visibleCounts = $state<Record<SectionKey, number>>({
        watching: PAGE_SIZE,
        onHold: PAGE_SIZE,
        completed: PAGE_SIZE,
        dropped: PAGE_SIZE,
        planToWatch: PAGE_SIZE,
    });

    // A narrowed filter should always start from the first page rather than
    // keeping whatever count was reached while scrolling a broader view.
    $effect(() => {
        query;
        selectedGenre;
        activeGroup;
        sortMode;
        visibleCounts = {
            watching: PAGE_SIZE,
            onHold: PAGE_SIZE,
            completed: PAGE_SIZE,
            dropped: PAGE_SIZE,
            planToWatch: PAGE_SIZE,
        };
    });

    function showMore(key: SectionKey) {
        visibleCounts[key] += PAGE_SIZE;
    }

    function switchGroup(group: "tv" | "anime") {
        activeGroup = group;
        selectedGenre = null;
    }

    // Keep the URL in sync with the filter state so a filtered view is
    // reload-safe and shareable — replaceState only (no goto), since these
    // filters are applied entirely client-side over already-loaded data and
    // shouldn't trigger a server round-trip.
    $effect(() => {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (selectedGenre) params.set("genre", selectedGenre);
        if (activeGroup !== "tv") params.set("group", activeGroup);
        if (sortMode !== "added") params.set("sort", sortMode);
        const search = params.toString() ? `?${params.toString()}` : "";
        // Skip when it's already correct (true on mount, since filter state is seeded
        // from the URL) — calling replaceState this early can throw "router is not
        // initialized yet" on a hard reload/direct load, which would otherwise permanently
        // kill this effect since an uncaught error stops it from ever re-running.
        if (search === location.search) return;
        try {
            replaceState(`${location.pathname}${search}`, {});
        } catch {
            // router not ready yet — safe to ignore, see above
        }
    });

    function inGroup(item: LibraryItem, group: "tv" | "anime"): boolean {
        return group === "anime"
            ? item.mediaType === "anime"
            : item.mediaType !== "anime";
    }

    async function retry() {
        retrying = true;
        try {
            await invalidateAll();
        } finally {
            retrying = false;
        }
    }

    function progressRatio(item: LibraryItem): number {
        if (!item.totalEpisodes) return item.watchedEpisodes > 0 ? 1 : 0;
        return item.watchedEpisodes / item.totalEpisodes;
    }

    function prepare(items: LibraryItem[]): LibraryItem[] {
        const needle = query.trim().toLowerCase();
        const genre = selectedGenre;
        const filtered = items.filter((item) => {
            const matchesQuery =
                !needle ||
                item.title.toLowerCase().includes(needle) ||
                item.genres.some((g) => g.toLowerCase().includes(needle));
            const matchesGenre = !genre || item.genres.includes(genre);
            return matchesQuery && matchesGenre;
        });

        const sorted = [...filtered];
        if (sortMode === "title") {
            sorted.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sortMode === "progress") {
            sorted.sort((a, b) => progressRatio(b) - progressRatio(a));
        } else if (sortMode === "rating") {
            sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
        } else {
            sorted.sort((a, b) =>
                a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0,
            );
        }
        return sorted;
    }

    function emptyMessage(fallback: string): string {
        if (query && selectedGenre)
            return `No matches for "${query}" in ${selectedGenre}.`;
        if (query) return `No matches for "${query}".`;
        if (selectedGenre) return `Nothing tagged ${selectedGenre}.`;
        return fallback;
    }

    function formatStaleSince(iso: string | null): string {
        if (!iso) return "a while ago";
        const hours = Math.round((Date.now() - new Date(iso).getTime()) / (60 * 60 * 1000));
        if (hours < 1) return "less than an hour ago";
        if (hours === 1) return "1 hour ago";
        if (hours < 48) return `${hours} hours ago`;
        return `${Math.round(hours / 24)} days ago`;
    }

    // Always pulls from TV/movies regardless of which tab is active — kept
    // separate from the anime library rather than a shared "surprise me
    // from whatever tab you're on", per explicit request.
    function surpriseMe() {
        const pool = data.planToWatch.filter(
            (item) => item.mediaType !== "anime",
        );
        if (pool.length === 0) return;
        spinning = true;
        // Brief delay before revealing so repeat rolls read as a new pick
        // rather than an instant swap.
        setTimeout(() => {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            pickedItem = pick;
            spinning = false;
        }, 350);
    }

    const hasAnime = $derived(
        [
            ...data.watching,
            ...data.completed,
            ...data.planToWatch,
            ...data.onHold,
            ...data.dropped,
        ].some((item) => item.mediaType === "anime"),
    );

    const groupWatching = $derived(
        data.watching.filter((item) => inGroup(item, activeGroup)),
    );
    const groupOnHold = $derived(
        data.onHold.filter((item) => inGroup(item, activeGroup)),
    );
    const groupCompleted = $derived(
        data.completed.filter((item) => inGroup(item, activeGroup)),
    );
    const groupDropped = $derived(
        data.dropped.filter((item) => inGroup(item, activeGroup)),
    );
    const groupPlanToWatch = $derived(
        data.planToWatch.filter((item) => inGroup(item, activeGroup)),
    );
    const groupSurprisePool = $derived(
        data.planToWatch.filter((item) => item.mediaType !== "anime"),
    );

    const filteredWatching = $derived(prepare(groupWatching));
    const filteredOnHold = $derived(prepare(groupOnHold));
    const filteredCompleted = $derived(prepare(groupCompleted));
    const filteredDropped = $derived(prepare(groupDropped));
    const filteredPlanToWatch = $derived(prepare(groupPlanToWatch));

    const completedThisYear = $derived.by(() => {
        const year = new Date().getFullYear();
        return groupCompleted.filter(
            (item) =>
                item.lastWatchedAt &&
                new Date(item.lastWatchedAt).getFullYear() === year,
        ).length;
    });

    const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const watchedGroups = $derived([
        ...groupWatching,
        ...groupCompleted,
        ...groupOnHold,
        ...groupDropped,
    ]);
    const allTrackedGroups = $derived([...watchedGroups, ...groupPlanToWatch]);

    const totalEpisodesWatchedTvOnly = $derived(
        watchedGroups
            .filter((item) => item.mediaType !== "movies")
            .reduce((sum, item) => sum + item.watchedEpisodes, 0),
    );
    const moviesCompletedCount = $derived(
        groupCompleted.filter((item) => item.mediaType === "movies").length,
    );

    const totalMinutesWatched = $derived(
        watchedGroups.reduce(
            (sum, item) => sum + item.watchedEpisodes * (item.runtime ?? 0),
            0,
        ),
    );
    const watchTime = $derived.by(() => {
        const totalMinutes = totalMinutesWatched;
        const days = Math.floor(totalMinutes / (60 * 24));
        const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
        const minutes = Math.round(totalMinutes % 60);
        return { days, hours, minutes };
    });
    // Runtime is only known once a title's detail entry has been fetched and
    // cached (see enrichLibrary in simkl.ts) — until then this undercounts.
    const hasIncompleteRuntimeData = $derived(
        watchedGroups.some(
            (item) => item.watchedEpisodes > 0 && item.runtime == null,
        ),
    );

    const peakYear = $derived.by(() => {
        const counts = new Map<number, number>();
        for (const item of watchedGroups) {
            if (!item.lastWatchedAt) continue;
            const year = new Date(item.lastWatchedAt).getFullYear();
            counts.set(year, (counts.get(year) ?? 0) + 1);
        }
        let best: number | null = null;
        let bestCount = 0;
        for (const [year, count] of counts) {
            if (count > bestCount) {
                best = year;
                bestCount = count;
            }
        }
        return best;
    });

    const peakWeekday = $derived.by(() => {
        const counts = new Array(7).fill(0);
        for (const item of watchedGroups) {
            if (!item.lastWatchedAt) continue;
            counts[new Date(item.lastWatchedAt).getDay()]++;
        }
        const best = counts.indexOf(Math.max(...counts));
        return counts[best] > 0 ? WEEKDAY_NAMES[best] : null;
    });

    const topGenres = $derived.by(() => {
        const counts = new Map<string, number>();
        for (const item of allTrackedGroups) {
            for (const genre of item.genres)
                counts.set(genre, (counts.get(genre) ?? 0) + 1);
        }
        const max = Math.max(1, ...counts.values());
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([genre, count]) => ({
                genre,
                count,
                pct: (count / max) * 100,
            }));
    });

    const backlogMinutes = $derived(
        groupPlanToWatch.reduce(
            (sum, item) =>
                sum + (item.totalEpisodes ?? 1) * (item.runtime ?? 0),
            0,
        ),
    );
    const backlogHours = $derived(Math.round(backlogMinutes / 60));

    const avgRating = $derived.by(() => {
        const rated = allTrackedGroups.filter((item) => item.rating != null);
        if (rated.length === 0) return null;
        return (
            rated.reduce((sum, item) => sum + (item.rating ?? 0), 0) /
            rated.length
        );
    });

    const completionRate = $derived.by(() => {
        if (allTrackedGroups.length === 0) return 0;
        return Math.round(
            (groupCompleted.length / allTrackedGroups.length) * 100,
        );
    });

    const allGenres = $derived(
        [
            ...new Set(
                [
                    ...groupWatching,
                    ...groupCompleted,
                    ...groupPlanToWatch,
                    ...groupOnHold,
                    ...groupDropped,
                ].flatMap((item) => item.genres),
            ),
        ].sort(),
    );
</script>

{#snippet grid(items: LibraryItem[])}
    <div
        class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
    >
        {#each items as item, i (item.href)}
            <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                class="card group overflow-hidden rounded-lg border border-border bg-surface/50 transition-colors hover:border-primary"
                style="transition-delay: {Math.min(i, 12) * 60}ms"
                use:reveal
            >
                <div
                    class="relative aspect-[2/3] w-full overflow-hidden bg-surface-2"
                >
                    {#if item.posterUrl}
                        <img
                            src={item.posterUrl}
                            alt=""
                            loading="lazy"
                            class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                    {:else}
                        <div class="grid h-full w-full place-items-center">
                            <Tv size={24} class="text-dim" aria-hidden="true" />
                        </div>
                    {/if}
                    {#if item.overview}
                        <div
                            class="absolute inset-0 hidden items-end bg-gradient-to-t from-bg/95 via-bg/60 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 sm:flex"
                        >
                            <p
                                class="line-clamp-6 text-[11px] leading-snug text-gray"
                            >
                                {item.overview}
                            </p>
                        </div>
                    {/if}
                    {#if item.rating}
                        <span
                            class="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-bg/80 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm"
                        >
                            <Star
                                size={10}
                                class="fill-primary text-primary"
                                aria-hidden="true"
                            />
                            {item.rating}
                        </span>
                    {/if}
                    {#if item.totalEpisodes}
                        <div
                            class="absolute inset-x-0 bottom-0 h-1 bg-black/40"
                        >
                            <div
                                class="h-full bg-primary"
                                style="width: {Math.min(
                                    100,
                                    progressRatio(item) * 100,
                                )}%"
                            ></div>
                        </div>
                    {/if}
                </div>
                <div class="p-3">
                    <p class="truncate text-sm font-medium text-white">
                        {item.title}
                    </p>
                    <p class="mt-0.5 text-xs text-dim">
                        {item.totalEpisodes
                            ? `${item.watchedEpisodes}/${item.totalEpisodes} episodes`
                            : "Movie"}
                    </p>
                    {#if item.genres.length}
                        <p class="mt-0.5 truncate text-[11px] text-dim">
                            {item.genres.slice(0, 2).join(" · ")}
                        </p>
                    {/if}
                    {#if item.nextToWatch}
                        <p class="mt-0.5 truncate text-[11px] text-primary">
                            Up next: {item.nextToWatch}
                        </p>
                    {/if}
                </div>
            </a>
        {/each}
    </div>
{/snippet}

{#snippet section(key: SectionKey, items: LibraryItem[], emptyFallback: string)}
    {#if items.length === 0}
        <p class="mt-4 text-sm text-dim">{emptyMessage(emptyFallback)}</p>
    {:else}
        {@render grid(items.slice(0, visibleCounts[key]))}
        {#if items.length > visibleCounts[key]}
            <div class="mt-6 flex justify-center">
                <button
                    type="button"
                    onclick={() => showMore(key)}
                    class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-white transition-colors hover:border-primary"
                >
                    Show {Math.min(PAGE_SIZE, items.length - visibleCounts[key])} more
                </button>
            </div>
        {/if}
    {/if}
{/snippet}

<Seo
    title="Watchlist — RazerGhost"
    description="Shows, movies, and anime I'm watching, have finished, and plan to watch."
    path="/watchlist"
/>

<main class="mx-auto max-w-6xl px-6 py-16">
    <h1
        class="text-3xl font-extrabold tracking-tight text-white"
        data-hero-reveal="0"
    >
        Watchlist
    </h1>
    <p class="mt-2 text-gray" data-hero-reveal="1">
        What I'm working through, have finished, and want to get to.
    </p>

    <div class="mt-4 flex flex-wrap items-center justify-between gap-4" data-hero-reveal="2">
        <ul class="flex flex-wrap gap-3">
            {#each watchProfiles as profile}
                {@const Icon = profileIcons[profile.icon]}
                <li>
                    <a
                        href={profile.href}
                        target="_blank"
                        rel="noreferrer"
                        class="link flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-gray transition-colors hover:border-primary hover:text-primary"
                    >
                        <Icon size={13} aria-hidden="true" />
                        {profile.label}
                    </a>
                </li>
            {/each}
        </ul>

        {#if hasAnime}
            <div
                class="inline-flex rounded-lg border border-border p-1"
                role="tablist"
                aria-label="Media type"
            >
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeGroup === "tv"}
                    onclick={() => switchGroup("tv")}
                    class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeGroup ===
                    'tv'
                        ? 'bg-primary/10 text-primary'
                        : 'text-gray hover:text-primary'}"
                >
                    TV & Movies
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeGroup === "anime"}
                    onclick={() => switchGroup("anime")}
                    class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeGroup ===
                    'anime'
                        ? 'bg-primary/10 text-primary'
                        : 'text-gray hover:text-primary'}"
                >
                    Anime
                </button>
            </div>
        {/if}
    </div>

    {#if !data.configured}
        <p class="mt-10 flex items-center gap-2 text-sm text-dim">
            <Tv size={15} aria-hidden="true" /> Simkl not connected.
        </p>
    {:else if data.error}
        <div class="mt-10 flex items-center gap-3 text-sm text-dim">
            <p>Couldn't reach Simkl right now.</p>
            <button
                type="button"
                onclick={retry}
                disabled={retrying}
                class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-white transition-colors hover:border-primary disabled:opacity-50"
            >
                <RefreshCw
                    size={12}
                    class={retrying ? "animate-spin" : ""}
                    aria-hidden="true"
                />
                {retrying ? "Retrying…" : "Retry"}
            </button>
        </div>
    {:else}
        {#if data.stale}
            <div class="mt-6 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-dim">
                <AlertTriangle size={14} class="shrink-0 text-warn" aria-hidden="true" />
                <p>
                    Simkl's unreachable right now — showing a cached copy from {formatStaleSince(
                        data.staleSince
                    )}.
                </p>
                <button
                    type="button"
                    onclick={retry}
                    disabled={retrying}
                    class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-white transition-colors hover:border-primary disabled:opacity-50"
                >
                    <RefreshCw size={12} class={retrying ? "animate-spin" : ""} aria-hidden="true" />
                    {retrying ? "Retrying…" : "Retry"}
                </button>
            </div>
        {/if}

        <div
            class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
            <div class="rounded-lg border border-border p-5 sm:p-6">
                <p class="text-xs font-medium uppercase tracking-wide text-dim">
                    Spent watching
                </p>
                <p class="mt-2 flex items-baseline gap-1.5 text-white">
                    <span class="text-4xl font-extrabold sm:text-5xl"
                        >{watchTime.days}</span
                    >
                    <span class="text-sm text-dim">d</span>
                    <span class="text-4xl font-extrabold sm:text-5xl"
                        >{watchTime.hours}</span
                    >
                    <span class="text-sm text-dim">h</span>
                    <span class="text-4xl font-extrabold sm:text-5xl"
                        >{watchTime.minutes}</span
                    >
                    <span class="text-sm text-dim">m</span>
                </p>
                <p class="mt-2 text-xs text-dim">
                    Estimated from average episode runtime — may differ
                    slightly from Simkl's own totals.
                </p>
                {#if hasIncompleteRuntimeData}
                    <p class="mt-1 text-xs text-dim">
                        Still warming up — some runtimes haven't been fetched
                        yet.
                    </p>
                {/if}

                <div
                    class="mt-5 grid grid-cols-3 gap-4 border-t border-border pt-5 text-center"
                >
                    <div>
                        <p class="text-xl font-bold text-white">
                            {groupCompleted.length}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Completed</p>
                    </div>
                    <div>
                        <p class="text-xl font-bold text-white">
                            {totalEpisodesWatchedTvOnly}{#if moviesCompletedCount > 0}<span
                                    class="text-dim"
                                >
                                    · +{moviesCompletedCount} movies</span
                                >{/if}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Episodes watched</p>
                    </div>
                    <div>
                        <p class="text-xl font-bold text-white">
                            {completedThisYear}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">
                            Completed this year
                        </p>
                    </div>
                </div>

                <div
                    class="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-4 text-center"
                >
                    <div>
                        <p class="text-xl font-bold text-white">
                            {peakYear ?? "—"}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Peak year</p>
                    </div>
                    <div>
                        <p class="text-xl font-bold text-white">
                            {peakWeekday ?? "—"}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Most active day</p>
                    </div>
                    <div>
                        <p class="text-xl font-bold text-white">
                            {avgRating ? avgRating.toFixed(1) : "—"}
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Avg rating</p>
                    </div>
                </div>

                <div
                    class="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4 text-center"
                >
                    <div>
                        <p class="text-xl font-bold text-white">
                            {groupPlanToWatch.length}<span class="text-dim">
                                · {backlogHours}h</span
                            >
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Backlog to clear</p>
                    </div>
                    <div>
                        <p class="text-xl font-bold text-white">
                            {completionRate}%
                        </p>
                        <p class="mt-0.5 text-xs text-dim">Completion rate</p>
                    </div>
                </div>
            </div>

            {#if topGenres.length}
                <div class="rounded-lg border border-border p-5 sm:p-6">
                    <p
                        class="text-xs font-medium uppercase tracking-wide text-dim"
                    >
                        Top genres
                    </p>
                    <ul class="mt-4 flex flex-col gap-3">
                        {#each topGenres as { genre, count, pct }}
                            <li>
                                <div
                                    class="flex items-center justify-between text-sm"
                                >
                                    <span class="text-white">{genre}</span>
                                    <span class="text-dim">{count}</span>
                                </div>
                                <div
                                    class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
                                >
                                    <div
                                        class="h-full rounded-full bg-primary"
                                        style="width: {pct}%"
                                    ></div>
                                </div>
                            </li>
                        {/each}
                    </ul>
                </div>
            {/if}
        </div>

        <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            {#if activeGroup === "tv" && groupSurprisePool.length > 0}
                <button
                    type="button"
                    onclick={surpriseMe}
                    disabled={spinning}
                    class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-white transition-colors hover:border-primary disabled:opacity-50 sm:mr-auto"
                >
                    <Shuffle
                        size={14}
                        class={spinning ? "animate-spin" : ""}
                        aria-hidden="true"
                    />
                    {spinning
                        ? "Picking…"
                        : pickedItem
                          ? "Reroll"
                          : "Surprise me"}
                </button>
            {/if}
            <input
                type="search"
                bind:value={query}
                placeholder="Search titles…"
                class="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-white placeholder:text-dim focus:border-primary focus:outline-none sm:max-w-sm"
            />
            <select
                bind:value={sortMode}
                aria-label="Sort"
                class="rounded-lg border border-border bg-transparent px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
            >
                <option value="added">Recently added</option>
                <option value="title">Title (A–Z)</option>
                <option value="progress">Progress</option>
                <option value="rating">Rating</option>
            </select>
        </div>

        {#if allGenres.length}
            <ul class="mt-4 flex flex-wrap gap-2">
                <li>
                    <button
                        type="button"
                        class="chip rounded-full border px-3 py-1 text-xs {selectedGenre ===
                        null
                            ? 'border-primary text-primary'
                            : 'border-border text-gray'}"
                        onclick={() => (selectedGenre = null)}
                    >
                        All genres
                    </button>
                </li>
                {#each allGenres as genre}
                    <li>
                        <button
                            type="button"
                            class="chip rounded-full border px-3 py-1 text-xs {selectedGenre ===
                            genre
                                ? 'border-primary text-primary'
                                : 'border-border text-gray'}"
                            onclick={() =>
                                (selectedGenre =
                                    selectedGenre === genre ? null : genre)}
                        >
                            {genre}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}

        {#if activeGroup === "tv" && pickedItem}
            {@const item = pickedItem}
            <div
                class="relative mt-4 overflow-hidden rounded-xl border border-border bg-surface/50"
                use:reveal
            >
                {#if item.posterUrl}
                    <div class="absolute inset-0 -z-10">
                        <img
                            src={item.posterUrl}
                            alt=""
                            class="h-full w-full scale-110 object-cover opacity-20 blur-2xl"
                        />
                        <div
                            class="absolute inset-0 bg-gradient-to-r from-bg via-bg/90 to-bg/70"
                        ></div>
                    </div>
                {/if}
                <button
                    type="button"
                    onclick={() => (pickedItem = null)}
                    aria-label="Dismiss"
                    class="absolute right-3 top-3 rounded-full border border-border bg-bg/70 p-1 text-dim transition-colors hover:border-primary hover:text-primary"
                >
                    <X size={14} aria-hidden="true" />
                </button>
                <div class="flex flex-col gap-5 p-5 sm:flex-row sm:p-6">
                    <div
                        class="mx-auto w-32 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:mx-0 sm:w-40"
                    >
                        {#if item.posterUrl}
                            <img
                                src={item.posterUrl}
                                alt=""
                                class="aspect-[2/3] w-full object-cover"
                            />
                        {:else}
                            <div
                                class="grid aspect-[2/3] w-full place-items-center"
                            >
                                <Tv
                                    size={24}
                                    class="text-dim"
                                    aria-hidden="true"
                                />
                            </div>
                        {/if}
                    </div>
                    <div
                        class="flex flex-1 flex-col justify-center text-center sm:text-left"
                    >
                        <p
                            class="text-xs font-medium uppercase tracking-wide text-primary"
                        >
                            Tonight's pick
                        </p>
                        <h3 class="mt-1 text-xl font-bold text-white">
                            {item.title}
                        </h3>
                        <div
                            class="mt-1.5 flex flex-wrap justify-center gap-x-2 gap-y-1 text-xs text-dim sm:justify-start"
                        >
                            {#if item.rating}
                                <span class="inline-flex items-center gap-1">
                                    <Star
                                        size={11}
                                        class="fill-primary text-primary"
                                        aria-hidden="true"
                                    />
                                    {item.rating}
                                </span>
                            {/if}
                            {#if item.genres.length}
                                <span
                                    >{item.genres.slice(0, 3).join(" · ")}</span
                                >
                            {/if}
                        </div>
                        {#if item.overview}
                            <p class="mt-3 line-clamp-3 text-sm text-gray">
                                {item.overview}
                            </p>
                        {/if}
                        <div
                            class="mt-4 flex flex-wrap justify-center gap-2 sm:justify-start"
                        >
                            <a
                                href={item.href}
                                target="_blank"
                                rel="noreferrer"
                                class="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                            >
                                <Play size={12} aria-hidden="true" /> Open on Simkl
                            </a>
                            <button
                                type="button"
                                onclick={surpriseMe}
                                disabled={spinning}
                                class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-primary disabled:opacity-50"
                            >
                                <Shuffle size={12} aria-hidden="true" /> Try another
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        {/if}

        <section class="mt-10">
            <h2 class="text-lg font-semibold text-white">Watching</h2>
            {@render section("watching", filteredWatching, "Nothing in progress right now.")}
        </section>

        {#if groupOnHold.length > 0}
            <section class="mt-14">
                <h2 class="text-lg font-semibold text-white">
                    On Hold <span class="text-dim">({groupOnHold.length})</span>
                </h2>
                {@render section("onHold", filteredOnHold, "Nothing on hold.")}
            </section>
        {/if}

        <section class="mt-14">
            <h2 class="text-lg font-semibold text-white">
                Completed <span class="text-dim">({groupCompleted.length})</span
                >
            </h2>
            {@render section("completed", filteredCompleted, "Nothing finished yet.")}
        </section>

        {#if groupDropped.length > 0}
            <section class="mt-14">
                <h2 class="text-lg font-semibold text-white">
                    Dropped <span class="text-dim">({groupDropped.length})</span
                    >
                </h2>
                {@render section("dropped", filteredDropped, "Nothing dropped.")}
            </section>
        {/if}

        <section class="mt-14">
            <h2 class="text-lg font-semibold text-white">
                Plan to Watch <span class="text-dim"
                    >({groupPlanToWatch.length})</span
                >
            </h2>
            {@render section("planToWatch", filteredPlanToWatch, "Nothing queued up.")}
        </section>
    {/if}
</main>
