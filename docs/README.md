# Docs index

In-depth, implementation-level documentation. Start with the top-level [README.md](../README.md) for setup and a quick tour — these docs go deeper on *how* each subsystem actually works, for when you're modifying it rather than just running it.

- [environment.md](environment.md) — one-time setup steps for every `.env` variable (OAuth apps, PIN flows, generating secrets)
- [content-pipeline.md](content-pipeline.md) — devlog + projects markdown pipeline, embeds, RSS/OG image generation
- [auth.md](auth.md) — GitHub OAuth login gate, session cookies
- [watchlist.md](watchlist.md) — Simkl integration, detail enrichment, outage fallback
- [listens.md](listens.md) — Spotify extended history import, live scrobbling, stats queries
- [integrations.md](integrations.md) — Spotify "now playing" widget, Discord presence, GitHub activity
- [deployment.md](deployment.md) — Docker build, Coolify/Traefik, persistent volumes, health checks
- [backups.md](backups.md) — git-based backup of `data/` to a private repo, SQL text dumps, FTS5 shadow table handling

Each doc assumes you've read the top-level README's environment variable table.
