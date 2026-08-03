# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-08-03

- Advance the title rotation after an unavailable movie so schedule generation cannot
  stall at a daypart boundary.

## 0.1.0 - 2026-08-03

- Initial public self-hosted release.
- Clock-synchronized Stremio channels with per-viewer HLS sessions.
- Named pools, dayparts, deterministic scheduling, and live guide generation.
- Direct TorBox and configured stream-addon resolution.
- Cinemeta, TMDB, Trakt, MDBList, and Stremio-library content sources.
- Web-based channel creator, presets, preview player, and operations diagnostics.
- Docker and hardware-accelerated NVENC, QSV, and VAAPI support.
