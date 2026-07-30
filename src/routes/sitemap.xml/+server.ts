import { getAllDevlogEntries } from '$lib/server/devlog';
import { getAllProjects } from '$lib/server/projects';
import { site } from '$lib/config';
import type { RequestHandler } from './$types';

const STATIC_ROUTES = ['/', '/projects', '/devlog', '/gear', '/watchlist', '/listens'];

function url(loc: string, date?: string): string {
	// Frontmatter dates arrive as inconsistently-stringified Date objects —
	// normalized to YYYY-MM-DD here. An unparseable date just drops
	// <lastmod> for that URL instead of throwing and 500ing the sitemap.
	const parsed = date ? new Date(date) : null;
	const lastmod =
		parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
	return `
	<url>
		<loc>${site.url}${loc}</loc>${lastmod ? `\n\t\t<lastmod>${lastmod}</lastmod>` : ''}
	</url>`;
}

export const GET: RequestHandler = () => {
	const entries = getAllDevlogEntries();
	const devlogUrls = entries.map((entry) => url(`/devlog/${entry.slug}`, entry.date));
	const tagUrls = [...new Set(entries.flatMap((e) => e.tags))].map((tag) =>
		url(`/devlog/tags/${tag}`)
	);
	const projectUrls = getAllProjects().map((project) =>
		url(`/projects/${project.slug}`, project.date)
	);
	const staticUrls = STATIC_ROUTES.map((route) => url(route));

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
		...staticUrls,
		...devlogUrls,
		...tagUrls,
		...projectUrls
	].join('')}
</urlset>`;

	return new Response(xml, {
		headers: { 'Content-Type': 'application/xml' }
	});
};
