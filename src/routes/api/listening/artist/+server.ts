import { json } from '@sveltejs/kit';
import { getArtistTopTracks } from '$lib/server/spotify-history';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const artist = url.searchParams.get('artist');
	if (!artist) return json({ tracks: [] });
	return json({ tracks: getArtistTopTracks(artist) });
};
