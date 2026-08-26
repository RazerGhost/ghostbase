<script lang="ts">
	/**
	 * Ported from Brand/design-system/components/Logo.jsx.
	 * `variant`:
	 *  - "mark"    → ghost mark in a circular avatar frame (static/brand/ghost-mark.svg)
	 *  - "outline" → inline/UI ghost outline (static/brand/ghost-outline.svg)
	 *  - "wordmark" → full lockup: wordmark text + small ghost mark, dark or
	 *    light field via `field`
	 */
	let {
		variant = 'outline',
		size = 28,
		field = 'dark'
	}: { variant?: 'mark' | 'outline' | 'wordmark'; size?: number; field?: 'dark' | 'light' } =
		$props();
</script>

{#if variant === 'wordmark'}
	<span class="inline-flex items-end gap-[7px]">
		<span
			class="text-[30px] leading-none font-extrabold tracking-tight"
			class:text-white={field === 'dark'}
			class:text-[#0a0a0a]={field === 'light'}
		>
			RazerGhost
		</span>
		<img
			src={field === 'dark' ? '/brand/ghost-mark.svg' : '/brand/ghost-mark-light.svg'}
			width="22"
			height="22"
			alt=""
			class="block"
		/>
	</span>
{:else if variant === 'mark'}
	<div
		class="grid shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-bg"
		style:width="{size}px"
		style:height="{size}px"
	>
		<img src="/brand/ghost-mark.svg" width={Math.round(size * 0.64)} height={Math.round(size * 0.64)} alt="" />
	</div>
{:else}
	<img src="/brand/ghost-outline.svg" width={size} height={size} alt="RazerGhost" />
{/if}
