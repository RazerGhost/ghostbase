// Read-only ICS ("iCalendar") feed support for the /newtab agenda widget —
// no OAuth, just a public/secret .ics URL (Google Calendar, Apple Calendar,
// Outlook, etc. all export one). Deliberately hand-rolled rather than a full
// RFC 5545 parser dependency: the widget only ever needs SUMMARY/DTSTART out
// of each VEVENT, so a small line-based scanner is enough.

export type AgendaEvent = { summary: string; start: Date; allDay: boolean };

type CacheEntry = { fetchedAt: number; events: AgendaEvent[] };

// Same "don't hammer the source, a server restart shouldn't force an
// immediate refetch" reasoning as unsplash.ts's photo cache — ICS feeds
// don't need per-request freshness, and some calendar providers rate-limit.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

// Unfolds RFC 5545 line continuations (a line starting with a space or tab is
// a continuation of the previous line) before splitting into logical lines.
function unfoldLines(raw: string): string[] {
	const lines: string[] = [];
	for (const line of raw.split(/\r\n|\n|\r/)) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
			lines[lines.length - 1] += line.slice(1);
		} else {
			lines.push(line);
		}
	}
	return lines;
}

// Parses a DTSTART value into a Date. Handles the three shapes calendar
// exports actually use:
//   DTSTART:20260725T090000Z        (UTC)
//   DTSTART;TZID=America/New_York:20260725T090000   (treated as local time —
//     a real per-event timezone conversion isn't worth the complexity here)
//   DTSTART;VALUE=DATE:20260725     (all-day)
function parseDtstart(value: string): { date: Date; allDay: boolean } | null {
	const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (dateOnly) {
		const [, y, m, d] = dateOnly;
		return { date: new Date(Number(y), Number(m) - 1, Number(d)), allDay: true };
	}
	const dateTime = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
	if (dateTime) {
		const [, y, m, d, hh, mm, ss, isUtc] = dateTime;
		const date = isUtc
			? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
			: new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
		return { date, allDay: false };
	}
	return null;
}

function parseIcs(raw: string): AgendaEvent[] {
	const lines = unfoldLines(raw);
	const events: AgendaEvent[] = [];

	let inEvent = false;
	let summary: string | null = null;
	let start: { date: Date; allDay: boolean } | null = null;

	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			summary = null;
			start = null;
			continue;
		}
		if (line === 'END:VEVENT') {
			if (inEvent && summary && start) {
				events.push({ summary, start: start.date, allDay: start.allDay });
			}
			inEvent = false;
			continue;
		}
		if (!inEvent) continue;

		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex);
		const value = line.slice(colonIndex + 1);

		if (key === 'SUMMARY') {
			// Unescape the handful of sequences RFC 5545 TEXT values use.
			summary = value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
		} else if (key === 'DTSTART' || key.startsWith('DTSTART;')) {
			start = parseDtstart(value);
		}
	}

	return events;
}

export async function getUpcomingEvents(icsUrl: string, limit = 5): Promise<AgendaEvent[]> {
	const cached = cache.get(icsUrl);
	const now = Date.now();
	let events: AgendaEvent[];

	if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
		events = cached.events;
	} else {
		const res = await fetch(icsUrl);
		if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
		events = parseIcs(await res.text());
		cache.set(icsUrl, { fetchedAt: now, events });
	}

	return events
		.filter((e) => e.start.getTime() >= now - 24 * 60 * 60 * 1000) // keep today's all-day events
		.sort((a, b) => a.start.getTime() - b.start.getTime())
		.slice(0, limit);
}
