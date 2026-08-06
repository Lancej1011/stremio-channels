# Stremio Channels

[![CI](https://github.com/Lancej1011/stremio-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/Lancej1011/stremio-channels/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/container-GHCR-blue.svg)](https://github.com/Lancej1011/stremio-channels/pkgs/container/stremio-channels)

Cable-style linear TV inside Stremio. You define channels — "Late Night Sci-Fi",
"90s Sitcoms" — and they run on a clock, 24/7. Tune in at 20:37 and you land 37 minutes
into whatever is airing, exactly like broadcast television.

This is not a playlist that starts from the beginning. It is a real, continuously
running video feed with a schedule behind it.

> [!IMPORTANT]
> This is self-hosted software, not a hosted streaming service. The host must stay on and
> every installation needs its owner's debrid credentials. Out of the box there is no
> authentication at all, so an unconfigured server belongs on localhost, a trusted LAN, or
> a private VPN — never on a forwarded port 7654. To reach it from outside, set an
> `accessToken` and put it behind an outbound tunnel; see
> [Watching from other devices](#watching-from-other-devices). The channel editor stays
> local-only either way.

```
▶ Now: Firefly - S01E05 - Out of Gas
   until 06:43 PM
   06:43 PM  Firefly - S01E10 - Objects in Space
   06:45 PM  Firefly - S01E07 - Safe
```

## How it works

Stremio addons cannot tell the player what to play next or where to seek to, so a
genuinely clock-synced channel has to be an actual video stream. This server:

1. builds a deterministic 24-hour schedule per channel from IMDb ids,
2. resolves each program to a seekable HTTPS link through a debrid service,
3. transcodes it into one continuous HLS live feed, seeking to the right offset, and
4. serves that feed, plus a Stremio addon that points at it.

The pipeline only runs while somebody is watching. Channels are conceptually always on,
but cost nothing when nobody is tuned in — the schedule is a function of wall-clock
time, not of a process staying alive.

## Requirements

- **Node.js 22+**
- **ffmpeg and ffprobe** on your PATH (any recent build; hardware encoding is detected
  automatically and falls back to CPU)
- **A debrid service** (TorBox, Real-Debrid, AllDebrid, Premiumize...)

Debrid is not optional. Programs must be seekable HTTPS files for the feed to join one
partway through; raw torrents cannot do that.

There are two ways to resolve programs:

**Direct TorBox** (`torboxApiKey`) — recommended if you use TorBox. Picks releases on
real byte sizes and parsed release names, extracts the right episode from season packs,
and drops the addon redirect from playback. Torrent hashes come from a plain indexer
addon (`indexerUrl`, default Torrentio), because TorBox has no search of its own.

**A configured stream addon** (`streamAddonUrl`) — works with any debrid service. Point
it at a Torrentio/Comet/MediaFusion install URL that already has your debrid key, and
this server just uses whatever links it returns. Simpler, and your API key stays out of
this server's config.

If both are set, TorBox wins.

## Setup

### Docker Compose (recommended)

```bash
git clone https://github.com/Lancej1011/stremio-channels.git
cd stremio-channels
mkdir -p config data
cp channels.example.json config/channels.json
cp .env.example .env
$EDITOR .env
docker compose up -d
```

Set either `TORBOX_API_KEY` or `STREAM_ADDON_URL` when your editor opens, then start the
container. Open
<http://127.0.0.1:7654/ui>, then install
`http://127.0.0.1:7654/manifest.json` in Stremio. See [DOCKER.md](DOCKER.md) for
NVENC, QuickSync/VAAPI, upgrades, and private HTTPS access.

### Native Node.js

```bash
npm install
npm run build

cp config.example.json config.json
cp channels.example.json channels.json
```

Edit `config.json` and set `streamAddonUrl` to your configured stream addon's install
URL. In Stremio, open Addons, find your debrid addon, and copy its link — it looks like
`https://torrentio.strem.fun/providers=.../manifest.json`. Paste the whole thing.

Then edit `channels.json`:

```json
{
  "channels": [
    {
      "id": "scifi",
      "name": "Late Night Sci-Fi",
      "seed": 1,
      "content": [
        { "type": "series", "id": "tt3230854" },
        { "type": "movie",  "id": "tt1856101" }
      ]
    }
  ]
}
```

`id` values are IMDb ids. A `series` entry expands into every episode automatically, so
a handful of shows becomes hundreds of programs. Add `"season": 1` to restrict a series
to one season. Change `seed` to reshuffle a channel.

Start it:

```bash
npm start
```

For an always-on native install cloned at `~/stremio-channels`, copy
`deploy/stremio-channels.service` to `~/.config/systemd/user/`, then run
`systemctl --user daemon-reload` and
`systemctl --user enable --now stremio-channels`. The supplied unit starts at boot when
user lingering is enabled and restarts after a crash. Use a systemd override if the
repository lives elsewhere.

Then install `http://127.0.0.1:7654/manifest.json` in Stremio: Addons → Add addon →
paste the URL. Your channels appear under the **Channels** catalog as TV items.

Stremio is optional. Open **http://127.0.0.1:7654/watch** for the standalone Headend
viewer: a full-screen live player with a TV-friendly program guide. It remembers the last
channel in that browser and supports arrow keys, Enter, Back/Escape, Page Up/Down and
fullscreen. Browsers that block autoplay show a Play button instead of failing silently.

## The Headend viewer

Headend is the read-only viewing surface; `/ui` remains the local administration surface.
Open the guide with Arrow Up or the Guide button, move through channels and programs with
the arrow keys, and press Enter to tune that channel live. Selecting a future program does
not provide catch-up or DVR playback.

Safari uses native HLS. Other modern browsers load the bundled HLS.js player, so the
viewer has no CDN dependency. Installable-app metadata is available over HTTPS, but guide
responses, private pages, playlists and video segments are never stored in an offline
cache.

### Linux desktop application

Linux can run Headend as a regular desktop application with its own GTK window, launcher,
native header controls and fullscreen mode. It uses the system WebKitGTK media engine—not
Electron—and starts the `stremio-channels.service` user service automatically when needed.

This installation needs the GTK 3 and WebKitGTK 4.1 Python bindings. They are already
present on the supported development system; on Debian/Ubuntu their package names are
normally `python3-gi`, `gir1.2-gtk-3.0` and `gir1.2-webkit2-4.1`.

```bash
npm run desktop:install
```

Open **Headend** from the Linux application menu, or run `headend`. For an unusual server
address, launch `headend --url https://server.example/<token>/watch` or set
`HEADEND_URL`. The default is the local `http://127.0.0.1:7654/watch` service.

Desktop shortcuts: F11 toggles fullscreen, Escape leaves fullscreen, Ctrl+G opens the
guide, and Ctrl+R reloads the viewer. The native header also provides previous/next
channel, guide, reload and fullscreen buttons.

### Native Android application

The [`android/`](android/) project is a native Media3 viewer for Android 8.0 and newer.
It has its own guide and requests a short-lived tune instruction from
`GET /viewer/tune/:channelId`. Compatible sources play directly at the channel's current
wall-clock offset; unsupported codecs and direct-play errors fall back automatically to
the existing HLS channel. The client retunes itself at program boundaries.

Build and install the debug APK:

```bash
cd android
export ANDROID_HOME=/path/to/Android/Sdk
./gradlew testDebugUnitTest assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On first launch, paste the private Watch URL shown in the Headend admin interface. See
[`android/README.md`](android/README.md) for LAN and away-from-home URL examples.

## The web UI

Open **http://127.0.0.1:7654/ui**. Editing `channels.json` by hand stays supported, but
the UI is easier:

- **Guide** — an EPG grid of what is scheduled across every channel.
- **Channels** — a guided creator separates content pools, playback order and the weekly
  clock. Search by title, combine reusable pools, assign weekday/weekend blocks, and
  project the next 12 hours before saving. Unsaved drafts survive closing the dialog.
- **Presets** — add or customize a complete network-style channel (see below).
- **Ops** — live/provisioning state, horizon progress, debrid cooldown, skip/regenerate,
  and a preview player so you can check a channel without opening Stremio.

Saving writes `channels.json` atomically, keeps a `.bak` of the previous version, and
hot reloads. Only channels whose programming actually changed are rebuilt, so editing one
never interrupts someone watching another.

## Content pools and smart channels

A channel can have several named pools, and each schedule block can combine any of them.
A pool contains pinned titles, an optional live source, and explicit exclusions. Pins
always remain; live matches refresh weekly by default. Existing channel-level
`content`/`source` definitions remain supported and are converted only when saved through
the guided creator.

Each pinned title has a **Find similar** action. It blends TMDB recommendations with
genre/keyword matches, then lets you add any selection as ordinary pins; browsing never
calls TorBox. The **Airtime weight** beside a pin matters only under `weighted` playback:
a weight of 2 gives that title roughly twice the selection share of a title at 1 while a
series still advances through its episodes in order.

**Rule (no setup required).** Genre, release-year range and minimum rating, matched
against Cinemeta. This needs no API key of any kind:

```jsonc
{
  "id": "videonasties",
  "name": "Video Nasties",
  "source": {
    "kind": "rule",
    "type": "movie",
    "genres": ["Horror"],
    "years": [1975, 1995],
    "minRating": 6.3,
    "limit": 30
  },
  "refreshHours": 168
}
```

That rule produces Halloween, Evil Dead II, The Thing, Jaws, They Live and so on, with
no hand-picking at all. The UI has a **Preview matches** button so a rule can be checked
before it goes on air. The channel editor's **Preview next 12 hours** goes further: it
shows the projected titles, episodes, order and dayparts without saving or spending
TorBox calls. Runtimes not already measured are clearly labelled as estimates.

**Imports.** `mdblist`, `trakt` and `stremio` (your own library) import a list instead of
matching a rule. Each needs a free credential in `config.json` — `mdblistApiKey`,
`traktClientId`, `stremioAuthKey` — and stays hidden in the UI until it is set. The
Stremio source takes an **auth key**, never your password.

Source results are cached for `refreshHours` (a week by default), so a smart channel does
not re-query on every schedule pass. If a source is unreachable when it does refresh, the
last known good list keeps the channel on air rather than emptying it.

**TMDB rules.** Add `tmdbReadAccessToken` (preferred) or `tmdbApiKey` to `config.json`
to unlock richer discovery:
included/excluded genres and keywords, years, rating and vote floors, runtime, language,
country, network, studio and sorting. TMDB results are mapped to IMDb ids for the existing
Stremio/TorBox pipeline. Metadata previews never call TorBox. The token is never returned
to the browser; the UI only reports whether it is configured.

The optional [`examples/tmdb-movie-genres.json`](examples/tmdb-movie-genres.json) is a
sanitized 19-channel movie pack covering every TMDB movie genre. It is intentionally not
the default: provisioning many channels consumes debrid requests, so preview the rules
and add channels gradually while watching the shared cooldown in **Ops**.

## Network presets

Nine ready-made channels, each a lineup plus a daypart grid that mirrors how that kind of
network programmed its day:

| Preset | Shape |
| --- | --- |
| Boomerang Classics | Scooby mysteries, Hanna-Barbera afternoons and late-night action |
| Cartoon Network Classics & Hits | Cartoon Cartoons mornings, afternoon action, modern prime time |
| Nick at Nite / classic sitcoms | Retro mornings, 90s staples weighted into prime time |
| Adult Swim | Adult animation, weighted heavily to the small hours |
| Sci-Fi channel | Anthology mornings, serialised prime time, overnight X-Files |
| Disney | The classic animated afternoon, modern Disney in the evening |
| Comedy Central | Daytime comedy, the raunchier material kept after 22:00 |
| Nicktoons | 90s Nick animation split into morning, afternoon and late blocks |
| Fox 5 Morning | School-morning cartoons and syndicated action throwbacks |

Applying a preset copies it into your channels. It stays fully editable and never changes
on its own. A preset whose channel id already exists is marked **Already represented**;
it is never silently duplicated. The existing channel can be opened as-is or explicitly
replaced after confirmation. These emulate programming *style* only — no network branding
is included.

For anything not covered by a preset, the channel editor annotates search results with the
network and years a show ran (via TVmaze), which makes assembling an era-accurate lineup
practical.

## Sharing channel guides

A guide is programming only: which titles air, in what order, under which daypart grid. It
carries no credentials, because nothing in a channel definition has any — the debrid
account, API keys and access token all live in `config.json`, and a channel's `source` holds
filter criteria rather than secrets. Every channel is re-validated against the schema on the
way out, so a field added there later cannot ride along unnoticed.

Whoever imports a guide supplies their own debrid account. Whether a channel actually plays
for them depends on what their provider has cached, so an import is never verified: the
scheduler already skips titles it cannot resolve.

**Export** from the Channels view. The whole lineup downloads as a JSON file and is copied
to the clipboard where the browser allows it. Or take a subset directly:

```bash
curl -s localhost:7654/api/channels/export?ids=scifi,sitcoms > guide.json
```

**Import** from the same view, either by pasting the guide or by linking to one someone
published — a raw gist URL, not a web page. **Preview** shows exactly what would change
without writing anything. Three collision modes decide what happens when an id already
exists:

| Mode | Behaviour |
| --- | --- |
| `rename` | Keep both; the imported channel arrives as `scifi-2` |
| `add` | Refuse the whole import and name the conflicts. The default |
| `replace` | Overwrite yours in place, keeping list position |

`add` is all-or-nothing: one collision means nothing is written, so a guide can never
half-apply.

Both endpoints are part of the editor surface, so they answer only on loopback and to hosts
named in `trustedHosts` — never through a tunnel, with or without an access token. A LAN
device already listed in `trustedHosts` can therefore import from its browser, which is how
you would do it from a phone at home. The desktop app reaches the same editor from its
toolbar; the Android client is a viewer and has no import of its own.

## Watching from other devices

Stremio only accepts an addon URL over plain HTTP when it is on `127.0.0.1`; other devices
need HTTPS. There are two ways to provide it, and the right one depends on whether you can
install Tailscale on the device that will be watching.

### Private tailnet — nothing to configure

If the watching device can run Tailscale, this is the simplest option and needs no token.
Keep the Compose port bound to loopback, install Tailscale on the server and the client,
then publish the local port privately:

```bash
tailscale serve --bg 7654
tailscale serve status
```

Tailscale reports a URL such as `https://channels.example.ts.net`. Put that exact origin
in `.env` and recreate the container:

```dotenv
PUBLIC_BASE_URL=https://channels.example.ts.net
```

```bash
docker compose up -d --force-recreate
```

Open `https://channels.example.ts.net/watch` for Headend, or install
`https://channels.example.ts.net/manifest.json` in Stremio. Tailscale's access rules are
the authentication boundary, and the whole server — editor included — is reachable to
anything on your tailnet.

### Public tunnel with an access token

For a device that cannot join a tailnet, such as a phone on cellular, set an `accessToken`
and expose the server through an outbound tunnel. The token becomes the first segment of
every URL, and without it the server answers `404` to everything.

Generate one, and treat it like a password:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

```dotenv
ACCESS_TOKEN=<the generated value>
PUBLIC_BASE_URL=https://channels.example.ts.net
```

Then publish the port. Funnel is outbound-only, so there is no port to forward and no
router to reconfigure:

```bash
tailscale funnel --bg 7654
```

Open `https://channels.example.ts.net/<token>/watch` for Headend, or install
`https://channels.example.ts.net/<token>/manifest.json` in Stremio. Both exact URLs are
shown under the wordmark in the editor, where clicking one copies it.

> [!IMPORTANT]
> **The channel editor is not reachable through the tunnel**, with or without the token.
> `/api`, `/debug` and `/ui` answer only to `127.0.0.1` and to hosts you name in
> `trustedHosts`, because a single secret shared with a media player is the wrong thing
> guarding a write API. Administer the server at `http://127.0.0.1:7654/ui` on the machine
> itself.

Two consequences worth knowing before you commit to this:

- Requests that arrive through any reverse proxy — including `tailscale serve` on the same
  hostname — are treated as remote, because that is what stops an attacker from spoofing a
  local `Host` header through Funnel. To administer over the tailnet rather than at the
  console, use the raw tailnet address (`http://100.x.y.z:7654/ui`) and add
  `100.x.y.z:7654` to `trustedHosts`. Funnel is per-port and does not intercept it.
- Rotating the token changes both private URLs, so Headend bookmarks must be updated and
  Stremio has to be reinstalled on every device.

As defence in depth, restrict the tunnel itself to the token path with
`tailscale funnel --set-path`, so a scan of the bare hostname finds nothing at all.

### Whichever you choose

LAN devices are remote once a token is set. Either install the token'd URL on them, or add
their view of the server to `trustedHosts`:

```dotenv
TRUSTED_HOSTS=192.168.1.58:7654
```

Bandwidth is the constraint people hit first. Each viewer costs a sustained upload of
whatever `video.bitrate` says — 6 Mbps by default, which is more upstream than many home
connections have. Drop it to `3000k` at 720p if playback stutters away from home.

Verified on Stremio desktop (flatpak 1.1.4): each catalog card is labeled with the channel
and current show (for example, `90s Sitcoms • Seinfeld`), while selecting it shows the full
now/next guide. Stremio does not update a catalog that remains open; leave and return to the
catalog to refresh the labels. The player treats channels as live and the seek bar is
correctly locked — you cannot scrub a channel, exactly as with real broadcast TV.

Stremio's Android and Android TV players use ExoPlayer, which is stricter about HLS.
Playback is verified on a Fire TV Stick 4K Max. Channels are served as a master playlist
carrying an accurate `CODECS` attribute, segment requests honour HTTP Range, and the
playlist comes back immediately rather than holding the connection open while the pipeline
warms up. If a channel will not play on a TV, `GET /debug/hls/<channel>` reports what the
server served and what the device actually asked for.

Each tune-in receives its own playback session. When a player keeps polling the playlist
but stops fetching segments, its encoder freezes; resuming continues at the held frame and
the session rejoins the wall-clock channel at the next program boundary. A second viewer
on the same channel keeps playing independently.

## Scheduling

Three strategies, set per channel and optionally overridden per daypart:

| Strategy | Behaviour |
| --- | --- |
| `shuffle` | Every episode of every show goes in one pot. Nothing repeats until the whole pool has aired. |
| `sequential` | Which show airs is random; each show advances to its *next* episode. How a rerun station behaves. |
| `weighted` | Like sequential, but titles are picked in proportion to their `weight`. |

`shuffle` competes at episode level, so a 200-episode sitcom will crowd out a single film.
`sequential` and `weighted` pick a *title* first and then walk it, which keeps films in
rotation alongside long-running series.

Which title airs is a pure function of `(seed, slot index)`, so the guide is reproducible.
Which *episode* airs is a stored counter, because "advance to the next episode" has to
survive a restart — otherwise a sequential channel would replay episode one forever.

### Dayparts

Optional blocks override the channel default for part of the day. Blocks can repeat every
day, weekdays, weekends or selected days and may combine named pools. Overnight ranges are
anchored to the day on which they start. The guided creator rejects overlaps; legacy JSON
retains first-match-wins precedence.

```json
"dayparts": [
  { "name": "Morning Cartoons", "start": "06:00", "end": "12:00",
    "days": ["mon", "tue", "wed", "thu", "fri"],
    "strategy": "sequential", "poolIds": ["classics", "action"] },
  { "name": "After Dark", "start": "22:00", "end": "02:00",
    "days": ["fri", "sat"], "poolIds": ["late-night"] }
]
```

A block may override only the strategy (keeping the channel's content), only the content,
or both.

## Configuration

Everything in `config.json` can also be set by environment variable, which wins over the
file: `PORT`, `HOST`, `PUBLIC_BASE_URL`, `ACCESS_TOKEN`, `TRUSTED_HOSTS`, `DATA_DIR`,
`CHANNELS_FILE`, `STREAM_ADDON_URL`, `TMDB_API_TOKEN`, `TMDB_API_KEY`, `ENCODER`,
`LOG_LEVEL`.

Useful knobs:

| Key | Default | Notes |
| --- | --- | --- |
| `accessToken` | — | Secret first path segment required of remote clients. Unset means no authentication at all |
| `trustedHosts` | `[]` | Host header values besides loopback allowed to reach the editor, as `192.168.1.58:7654` |
| `video.bitrate` | `6000k` | Output bitrate per channel |
| `hls.segmentSeconds` | `2` | Encoders run at real time, so this sets how long tuning in takes |
| `idleShutdownSeconds` | `120` | How long a feed survives with nobody watching |
| `scheduleHorizonHours` | `24` | How far ahead the guide is built |
| `encoder` | `auto` | `nvenc`, `qsv`, `vaapi` or `cpu` to override detection |
| `hls.masterPlaylist` | `true` | Serve a master playlist with `CODECS`. `false` restores the old bare media playlist |
| `hls.playlistWaitSeconds` | `20` | How long a media playlist request waits for the pipeline before a `503` |
| `hls.pauseDetectSeconds` | `8` | Playlist-only interval before a claimed viewer is treated as paused |
| `maxSessions` | `6` | Maximum concurrent viewer sessions/encoders before LRU eviction |
| `hls.programDateTime` | `false` | Add `EXT-X-PROGRAM-DATE-TIME` |
| `hls.codecs` | — | Override the advertised codec string outright |
| `video.profile` | `high` | `main` if a player rejects High profile |
| `video.level` | `auto` | Pin an H.264 level. `auto` is the safe value |

The Phase 3 knobs above also have environment equivalents — `HLS_MASTER_PLAYLIST`,
`HLS_PLAYLIST_WAIT_SECONDS`, `HLS_PROGRAM_DATE_TIME`, `HLS_CODECS`, `VIDEO_PROFILE`,
`VIDEO_LEVEL` — so a device can be tested against several settings without editing a file.

Leave `video.level` on `auto` unless a specific player demands otherwise: a pinned level a
hardware encoder cannot satisfy makes it refuse to start, which takes the channel off air
rather than fixing playback.

## Diagnostics

- `GET /health` — which channels exist and which are currently live
- `GET /viewer/guide.json?hours=6` — the sanitized read-only guide used by Headend
- `GET /guide` — plain-text now/next for every channel
- `GET /api/status` — adds `debridCalls`, a running count of debrid API requests by
  endpoint. Debrid rate limits are the binding constraint on how fast channels fill, so
  calls-per-scheduled-program is the number to watch if generation feels slow.
- `GET /debug/hls/<channel>` — everything about how a channel is being served: the master
  and media playlists verbatim, the advertised codec string next to one measured from a
  real segment, the encoder in use, and a log of the last 64 feed requests with their
  status, `Range` header and User-Agent. `GET /debug/hls` gives the same for every channel
  in one request. This exists so "it won't play on my TV" can be answered with data.

The two fields worth checking first are `publicBaseUrlIsLoopback` (a stream URL pointing at
127.0.0.1 is unreachable from any other device) and `codecsAgree` (false means the server is
describing the stream to the player as something it is not). `accessTokenConfigured` tells
you whether a device that cannot reach the server is failing on routing or on a missing
token; the token itself is masked as `<token>` throughout, so this output is safe to paste
into an issue.

With an `accessToken` set, `/health` and `/guide` need it too (`/<token>/health`), and
`/api` and `/debug` are local-only — reach them from the machine itself.

## Tests

```bash
npm test              # unit tests, under a second
npm run test:integration   # the real pipeline, about two minutes
```

The integration suite drives real ffmpeg encoders, a real packager and a real database
against synthetic local sources, and asserts the properties that cannot be checked by
reading code: that video timestamps stay monotonic and hole-free across program changes,
that a dead source is covered by a slate without dropping the feed, that a channel
resumes at the wall-clock offset after shutdown, that a paused session resumes without a
segment burst, that two viewers remain independent, and that editing one channel does not
interrupt someone watching another. It runs in real time by necessity, which is why it is
not part of `npm test`.

## Known limitations

- **16-37ms of audio overlap at each program change.** AAC frames are 21.3ms and program
  boundaries do not land on frame boundaries: the outgoing encoder rounds up to a whole
  frame while the incoming one starts up to a frame early, which caps the overlap at two
  frames (~43ms). Video is unaffected and stays perfectly monotonic; the artifact is
  inaudible, but it does show up as a DTS warning if you remux the stream. The integration
  suite measures this at every program change and fails if it grows or starts to
  accumulate into audio/video drift.
- **Tuning in takes a few seconds.** Encoders run at real time by necessity, so a player
  cannot start until two segments have genuinely elapsed. Opening a channel in Stremio
  starts the pipeline before you press play, which hides most of this. Measured at ~18s
  on a cold channel, considerably less once warm.
- **A new channel provisions gradually.** The current slot is prepared first, then a
  round-robin coordinator fills the guide. Torrent/file choices and measured runtimes are
  cached; expiring download links are generated only near airtime.
- **Debrid rate limits are the binding constraint, not bandwidth.** Requests are paced,
  cached-only torrent creation is enforced, and any 429 creates a shared adaptive
  cooldown. A five-minute horizon keeper resumes incomplete schedules automatically;
  requests fail fast instead of stalling, and `/health` reports
  `debridCooldownSeconds` so it is obvious what is happening.
- **All bytes flow through this server.** Debrid → here → Stremio. Fine on a LAN, a real
  constraint if you expose it remotely.
- **One viewer session = one transcode.** Independent pause requires separate pipelines
  even when two viewers choose the same channel. `maxSessions` bounds GPU usage and evicts
  the least recently active session when full.
- **A segment that has scrolled out of the live window is gone.** The playlist holds
  `hls.listSize` segments (24 seconds by default), so a player that falls further behind
  than that gets a 404 and has to rejoin at the live edge. Raise `hls.listSize` if a
  device buffers more aggressively than that.

## Current scope

The end-to-end channel pipeline, guided web creator, named/live content pools, weekly
dayparts, EPG, direct TorBox resolution and independent viewer pause/resume are all in
place. Trakt, MDBList and Stremio-library imports remain available alongside Cinemeta and
TMDB discovery. Bumpers, station IDs and filler-aware timing are the main programming
features not yet implemented.

## Credits and responsible use

This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise
approved by TMDB. TMDB metadata is optional and requires the operator's own API token.
TV metadata may also be provided by TVmaze.

Stremio Channels does not include media, debrid credentials, or a hosted service. Each
operator is responsible for the content they access and for complying with applicable
law and the terms of their metadata, indexer, addon, and debrid providers.

Released under the [MIT License](LICENSE). Security reports should follow
[SECURITY.md](SECURITY.md).
