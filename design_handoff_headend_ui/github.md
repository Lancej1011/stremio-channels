repo: Lancej1011/stremio-channels
branch: main

## Last sync
date: 2026-08-03T20:09:36Z
commit: 39fcc0275c1149b24da5eb075e90011c680f5fb4

### Updated in this project
- Read README, src/api.ts, src/config.ts, channels.example.json, presets/cartoon-time-capsule.json, and the current src/ui/index.html styles.
- Built Headend.dc.html: redesigned admin UI covering Dashboard, Channels, Channel Editor, Presets, Program Guide, Operations.
- Fixture payloads mirror the real /api/status, /api/guide, /api/presets and /api/channels shapes; the design probes /api/status at load and labels itself Live API or Sample data.

## Screen map
| Screen | Built from |
| --- | --- |
| Dashboard | src/api.ts (/api/status, cooldownSeconds, debridCalls), README diagnostics |
| Channels | src/api.ts (/api/channels, /api/status), channels.example.json |
| Channel Editor | src/config.ts (channelSchema, contentPoolSchema, daypartSchema), /api/search, /api/channels/preview |
| Presets | src/api.ts (/api/presets, /api/presets/apply), presets/*.json |
| Program Guide | src/api.ts (/api/guide), src/schedule/clock.ts |
| Operations | src/api.ts (skip, regenerate), README HLS session + limitations sections |
