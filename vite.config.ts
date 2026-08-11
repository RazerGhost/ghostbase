import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		// These ship raw, uncompiled .svelte files as their icon components —
		// SSR needs Vite to run them through vite-plugin-svelte rather than
		// externalizing them straight to Node's ESM loader (which can't
		// handle .svelte files).
		noExternal: ['@lucide/svelte', '@icons-pack/svelte-simple-icons']
	},
	test: {
		// Pure string-transform functions (markdown post-processing), not
		// components — no jsdom/browser environment needed.
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
