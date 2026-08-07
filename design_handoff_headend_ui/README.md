# Handoff: Stremio Channels admin UI redesign

Target repo: `Lancej1011/stremio-channels`, branch `main`, last read at commit
`39fcc0275c1149b24da5eb075e90011c680f5fb4`. The file to change is `src/ui/index.html`.

## Overview

A redesign of the self-hosted admin interface for Stremio Channels — the clock-synced
linear-TV server. Six views: Dashboard, Channels, Channel Editor, Presets, Program Guide,
Operations. The redesign is visual and structural only. No backend endpoint, request
format, channel schema, or playback behavior changes.

## About the design files

`Headend.dc.html` in this bundle is a **design reference created in HTML** — a prototype
showing intended look, layout, and behavior. It is not production code to paste in.

The repo's UI is deliberately dependency-free vanilla HTML/CSS/JS in a single
`src/ui/index.html`, served by Fastify. **Keep that architecture.** Recreate the design as
plain CSS classes and vanilla JS in `src/ui/index.html`, wired to the real API calls that
file already makes. Do not introduce React, a bundler, or a build step for the UI.

The prototype is written in a streaming component format with inline styles and stub data;
read it for layout, hierarchy, copy, and exact values, then re-express it as:

- a `<style>` block of reusable classes (`.panel`, `.tile`, `.chip`, `.chip--live`,
  `.row`, `.guide-cell`, `.btn`, `.btn--primary`, `.bar`), and
- one render function per view, fed by the existing fetch calls.

## Fidelity

**High-fidelity.** Colors, type, spacing, and states below are final. Match them.

## Data contract — use the real API

Every number and label in the prototype is stubbed. In the real UI each view reads the
endpoints the server already exposes (see `src/api.ts`). Do not ship static data.

| View | Endpoints |
| --- | --- |
| Dashboard | `GET /api/status` (`cooldownSeconds`, `debridCalls`, `channels[].live` + provisioning), `GET /api/channels`, `GET /health` |
| Channels | `GET /api/channels`, `GET /api/status`, `GET /api/guide?hours=2` for now/next |
| Channel Editor | `GET /api/search?q=&type=`, `GET /api/lookup/:imdbId`, `GET /api/sources`, `GET /api/metadata/options`, `GET /api/metadata/search`, `GET /api/metadata/similar`, `POST /api/sources/preview`, `POST /api/channels/preview`, `PUT /api/channels` |
| Presets | `GET /api/presets`, `POST /api/presets/apply` with `{key, mode:"add"\|"replace"}` |
| Program Guide | `GET /api/guide?hours=` (1–48; UI offers 3/6/12) |
| Operations | `GET /api/status`, `POST /api/channels/:id/skip`, `POST /api/channels/:id/regenerate`, `GET /debug/hls/:channel` behind a "Raw debug" link |

Schema authority is `src/config.ts` (`channelSchema`, `contentPoolSchema`, `daypartSchema`,
`sourceSchema`). The editor must respect: pools cannot be combined with legacy
`content`/`source`; pool-based channels need at least one `defaultPoolIds` entry; a daypart
cannot set both `content` and `poolIds`; ids are `^[a-z0-9][a-z0-9-]*$`; times are
`HH:MM` 24-hour; overlapping dayparts are rejected. Surface `PUT /api/channels` 400
`detail` issues inline on the offending field rather than as a raw JSON dump.

`GET /api/presets` already returns `installed` and `existingChannelId` — that drives the
"Already represented" state. `POST /api/presets/apply` returns 409 when mode/existence
disagree; show that as a confirm dialog, never a silent retry.

## Design tokens

Colors (hex, dark theme only in this pass):

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0b0c0f` | page background |
| `--panel` | `#101318` | panels, cards |
| `--panel-2` | `#14171d` | inset rows, guide cells, inputs on panels |
| `--panel-3` | `#171a21` | secondary buttons, active nav |
| `--rail` | `#0e1014` | left rail, card footers |
| `--line` | `#22262f` | primary hairline |
| `--line-soft` | `#191d25` | row dividers |
| `--line-strong` | `#2b313d` / `#2f3542` | input borders / button borders |
| `--text` | `#e6e8ee` | primary text |
| `--text-2` | `#cfd4de` | secondary text |
| `--dim` | `#8b93a3` | labels, meta |
| `--dim-2` | `#6d7484` | mono meta, hints |
| `--faint` | `#4f5665` | footer |
| `--amber` | `#f5b544` | accent: now-marker, attention, primary hover |
| `--amber-tint` | `rgba(245,181,68,.08–.14)` | daypart blocks, primary button fill |
| `--green` | `#4fd18b` | on air, healthy, save |
| `--red` | `#f2604a` | failures, destructive hover |
| `--blue` | `#6fa8dc` | informational / "already represented" |

Rules: status is always dot + mono text label, never color alone. Amber is reserved for
*now* and *needs attention* — do not use it decoratively. No gradients except the artwork
placeholder stripe: `repeating-linear-gradient(135deg, #171a21 0 7px, #1c2029 7px 14px)`.

Typography:

- UI: `Archivo` (Google Fonts, 400/500/600/700), fallback `"Helvetica Neue", Helvetica, sans-serif`.
- Machine values — ids, times, endpoints, counts, percentages, encoder names, section
  eyebrows: `"IBM Plex Mono"` (400/500/600). This split carries most of the hierarchy.
- Scale: page title 18/600; section heading 13.5/600; body 12.5–13; card title 14.5/600;
  meta 12/400 dim; mono meta 10.5–11.5; eyebrow 10px mono, `letter-spacing .14em`,
  uppercase; big stat 27px mono 500, `font-variant-numeric: tabular-nums`,
  `letter-spacing -.02em`. Times and counts always tabular-nums.

Radii: 10px panels/cards, 6–7px buttons and inputs, 5px small buttons and pool chips,
4px guide cells and artwork, 3px status chips, 999px filter pills, 2–3px progress bars.

Spacing: page padding `22px 24px 40px`; panel header `13px 16px`; row `12px 16px`; card
body `14px`; grid gaps 12–16px; inline gaps 6–14px. Progress bars: 3px tall in cards, 5px
in Ops, track `#22262f`.

No shadows anywhere. Depth comes from the `#22262f` hairline plus the panel/bg step.

## Layout shell

`display: grid; grid-template-columns: 232px 1fr`.

**Left rail** (`--rail`, `border-right: 1px solid var(--line)`, sticky full height, padding
`20px 14px`): wordmark block — pulsing 10px green square (`@keyframes onair`, 2.4s
ease-in-out, opacity 1 → .35), `HEADEND` eyebrow, "Stremio Channels" 17/600, then the base
URL in mono 11px dim. Nav: six full-width buttons, `9px 10px`, 6px radius, each a mono
two-digit index (dim), label, and right-aligned mono badge (channel count, preset count,
sessions). Active: `background #171a21`, `border 1px solid #2f3542`, amber label. Hover:
`background #171a21`, text `--text`. Bottom card: "Data source" — live dot + label + note.

**Top bar** (sticky, `z-index 20`, `rgba(11,12,15,.92)` + `backdrop-filter: blur(8px)`,
`padding 14px 24px`, bottom hairline): view title 18/600 with a one-line dim subtitle;
right side — `WALL` clock chip (mono, ticking, HH:MM:SS), health chip (dot + label,
green/amber), and a Refresh button (`#171a21`, `#2f3542` border, amber on hover).

Responsive: below ~1100px the rail collapses to a top row of horizontally scrolling nav
pills and the two-column view bodies become one column. Below ~640px cards go full width
and the guide keeps its horizontal scroll. Touch targets stay ≥44px on mobile.

## Views

### 1. Dashboard
- Four stat tiles, `repeat(auto-fit, minmax(215px,1fr))`, gap 12: eyebrow + status dot,
  27px mono value with a small unit beside it, one dim note line. Tiles: Service (ffmpeg /
  encoder detected), Sessions (`n of maxSessions`, amber at ≥5 of 6), Channels on air
  (`n of total`), Debrid cooldown (`cooldownSeconds`, amber when non-zero).
- Body grid `minmax(0,1.55fr) minmax(0,1fr)`, gap 16, `align-items: start`.
- **On air now** panel: header with pulsing green square + "n feeds running". Rows are
  `46px | 1fr | auto`: 46×62 artwork placeholder with channel initials in mono; channel
  name 13.5/600 + mono id; current program 13px truncated; 3px green progress bar
  (elapsed / duration of the current program); mono line `until HH:MM` and
  `next HH:MM · <title>`; right column status chip (outlined in the status color) over the
  encoder name.
- **Schedule coverage** panel: horizon badge (`scheduleHorizonHours`), then one row per
  warning — 8px square in the severity color, title 13/500, 12px dim explanation, and a
  small action button (Regenerate channel / Open editor / Show config). Warnings come from
  provisioning state in `/api/status`, uncovered daypart windows, and
  `publicBaseUrlIsLoopback`.
- **Debrid calls** panel: `debridCalls` entries as endpoint (mono, truncating) + 84px amber
  mini-bar normalized to the largest count + right-aligned tabular count. Header shows
  cooldown, amber when active.

### 2. Channels
- Filter row: pills (`999px`, dot + label + mono count) for All / Healthy / Generating /
  Warning / Off air; active pill `border #3f4756`, `background #171a21`. "New channel" is
  right-aligned, amber outline on `rgba(245,181,68,.12)`.
- Card grid `repeat(auto-fill, minmax(290px,1fr))`, gap 14. Card body `78px | 1fr`: 108px
  tall 2:3 artwork placeholder (bottom-left mono hint "channel art 2:3"; swap for
  `channel.poster` when set), name 14.5/600 with `text-wrap: pretty`, outlined status chip
  top-right, mono meta line `id · strategy · seed n · n titles`, then a two-line now/next
  block — `NOW` in green mono for the current title, the next start time in dim mono for
  the next title — and a 3px progress bar in the status color. Footer strip (`--rail`,
  top hairline): four equal buttons — Edit, Preview, Guide, Ops — amber border/text on
  hover.
- States: Healthy green `ON AIR`, Generating amber, Warning amber, Off air dim with
  progress 0 and "Off air — schedule ready" instead of a title. Empty state: a single
  dashed panel pointing at Presets and `channels.example.json`.

### 3. Channel Editor
- Sticky action bar under the header (`--rail`): breadcrumb `Channels / <name> / <id>` in
  mono; right side — amber "Unsaved changes" indicator (only when dirty), "Preview next 12
  hours" secondary, "Save channel" green outline on `rgba(79,209,139,.14)`. Save is
  disabled until the draft validates; the draft persists across dialog close (existing
  behavior).
- Body grid `minmax(0,1fr) 360px`, gap 16; right column sticky at `top: 74px`.
- **Identity and playback**: name / id (read-only, mono) / seed inputs — inputs are
  `#0b0c0f`, `1px solid #2b313d`, 6px radius, `8px 10px`. Strategy is three selectable
  cards, not a `<select>`: mono key + 11.5px dim one-line explanation, selected card gets
  `border rgba(245,181,68,.55)` on `rgba(245,181,68,.08)` with an amber key and
  `aria-pressed`.
- **Content pools**: header shows "n pools · n pinned titles · n live rules" and an "Add
  pool" button. Each pool row: name 13/600, mono id, an outlined kind badge
  (`pinned` / `rule · Cinemeta` / `tmdb` / `mdblist` / `trakt` / `stremio`), right-aligned
  pinned count, then pinned titles as chips (`#14171d`, `1px solid #2b313d`, 5px radius)
  each carrying its `×weight` in dim mono — weight is only meaningful under `weighted`, so
  dim it further otherwise. A "+n more" text affordance expands. Keep the existing
  Find similar and Preview matches actions on the pool.
- **Daypart schedule**: a 24-hour track per rule group (Mon–Fri / Sat / Sun / Uncovered).
  Hour ticks 00:00–24:00 in mono above. Blocks are absolutely positioned by
  `left = start/24*100%`, `width = duration/24*100%`, `border rgba(245,181,68,.45)` on
  `rgba(245,181,68,.14)`, `cursor: grab`, label truncated, full window in `title`.
  Overnight blocks are anchored to the day they start, so a block ending at 02:00 renders
  to hour 26 on its own row. Uncovered hours render as a muted `#171a21` block labelled
  "channel default · <strategy>". Below the track, a validation strip — amber-tinted when
  advisory, red-tinted when blocking, listing the exact rejected overlap.
- **Content library** (right, top): search input for `/api/search`, min 2 characters,
  debounced. Result rows are `34px | 1fr | auto`: 34×46 poster, name 12.5/500, mono meta
  `type · year · network` (network/years from `/api/lookup/:imdbId`), and a "Pin" button
  that goes green on hover. Loading = three shimmer rows; no results = one dim line.
- **Projected lineup** (right, bottom): output of `POST /api/channels/preview`, `54px | 1fr`
  rows — mono time, title, mono note `<daypart> · <n>m (measured|estimated)`. Header note
  "no debrid calls".

### 4. Presets
- One 660px-max intro paragraph (13/1.55 dim) stating that applying copies the lineup and
  daypart grid, that it stays editable, and that presets emulate programming style only
  with no network branding.
- Card grid `repeat(auto-fill, minmax(340px,1fr))`, gap 14. Card: label 15/600, mono key,
  outlined state chip — `AVAILABLE` green / `ALREADY REPRESENTED` blue; summary 12.5/1.5
  dim with `text-wrap: pretty`; mono stat line "n titles · n pools · n dayparts"; then the
  daypart list as `96px | 1fr` rows (mono window, truncated name). Available cards get a
  faint green border `rgba(79,209,139,.28)`; represented cards stay neutral. Footer:
  "Preview lineup" secondary + primary "Apply preset" (green) or "Replace channel"
  (neutral, opens a confirm dialog naming the channel that will be overwritten). Disabled
  primary uses 50% opacity and `cursor: not-allowed`.

### 5. Program Guide
- Range pills 3h / 6h / 12h (mono) and a right-aligned legend — a 2px amber tick plus
  `now HH:MM`.
- Horizontally scrolling grid, `4px per minute`. Timeline starts at the half hour before
  now (`floor to :00/:30`, minus 30 min) so there is a little past context. Header row
  `176px | 1fr`: `CHANNEL` eyebrow, then labels every 30 minutes, each absolutely
  positioned at `minutes * 4px` with a `border-left: 1px solid #22262f` and 6px left pad.
  Do not offset this header with sticky `top` while it sits inside the horizontal scroll
  wrapper — it overlapped row 1 that way; scroll it with the grid.
- Now marker: 2px amber vertical line at `176 + (now - start)/60000 * 4` px, spanning all
  rows, `pointer-events: none`, `z-index 5`.
- Channel rows: 62px tall. Left cell (`--rail`, right hairline) is a button — status dot +
  name 13/600, mono id, `#14171d` on hover — that navigates to that channel. Cells are
  absolutely positioned blocks, `min-width 40px`, 4px radius, `#14171d` on `#262b35`, with
  title 12px truncated and mono sub `HH:MM · <n>m · <daypart>`. The currently-airing cell
  gets `border #4fd18b` on `rgba(79,209,139,.12)` with a green sub line.
- Keyboard: left/right cell focus moves along a channel, up/down between channels, Home
  jumps to now. Every cell needs a `title` with the full program name.

### 6. Operations
- Page grid `minmax(0,1.35fr) minmax(0,1fr)`, gap 16.
- **Active HLS sessions**: header shows "n of maxSessions · LRU eviction at cap". Rows are
  a wrapping flex line (not a fixed-column grid — fixed columns collapsed the name at this
  panel width): channel name 13/500 with the client string beneath in mono
  (`Stremio 1.1.4 · flatpak`, `ExoPlayer · Fire TV Stick 4K Max`), then mono encoder,
  mono uptime, outlined state chip (`PLAYING` green / `PAUSED` amber), and a right-pushed
  "Evict" button that turns red on hover and confirms first.
- **Schedule generation**: `minmax(120px,1fr) minmax(60px,110px) 62px` rows — channel name
  with mono note "<n>h of 24h filled · <strategy>", a 5px progress bar (green above 90%,
  amber below), and a right-aligned label (`complete` or a percentage).
- **Diagnostics**: each entry is a severity square, title 12.5/500, right-aligned mono
  time, then a plain-language explanation of what happened and what the server did about
  it — not a stack trace. Two actions: a specific fix (Retry resolve / View cooldown /
  Raise maxSessions / Re-measure) and a quiet "Raw debug" text button that opens
  `/debug/hls/<channel>`. Severity: amber for skipped programs and 429s, blue for
  informational eviction, red for a `codecsAgree: false` mismatch.
- **Preview player**: 16:9 placeholder for the HLS preview with the channel id in mono,
  then "Skip current" and "Regenerate" (red on hover), plus a dim explanation that
  regenerate resets stored episode counters and rebuilds the horizon, and that viewers
  rejoin at the next program boundary. Both confirm before firing.

## Interactions and states

- Nav is client-side view switching; keep the URL hash in sync so a view is linkable.
- Every mutating action (apply/replace preset, evict, skip, regenerate, save) confirms,
  disables its button while in flight, and reports the outcome in the footer status line.
- Loading: skeleton rows in panels (3 rows), never a full-page spinner. The clock and
  now-marker keep ticking while data loads.
- Empty: one dim sentence plus the single most useful action.
- Error: inline amber/red strip inside the affected panel with the server's message and a
  Retry; a failed poll must not blank an already-rendered panel.
- Poll `/api/status` every 10s and `/api/guide` every 60s; pause polling when the tab is
  hidden.
- Focus: `:focus-visible` = `2px solid #f5b544`, `outline-offset: 2px`. Full keyboard
  reachability, `aria-current="page"` on the active nav item, `aria-pressed` on strategy
  cards, `aria-live="polite"` on the footer status line.
- Footer line under every view carries either the last action result or the standing note
  that saving writes `channels.json` atomically, keeps a `.bak`, hot reloads, and rebuilds
  only channels whose programming changed.

## Assets

None. All imagery is a CSS stripe placeholder awaiting real channel artwork
(`channel.poster`) or a Cinemeta/TMDB poster. Fonts are Archivo and IBM Plex Mono from
Google Fonts — if you would rather not add a network dependency to a self-hosted admin UI,
self-host both under `src/ui/` or fall back to `system-ui` + `ui-monospace` and keep the
same size/weight scale.

## Non-goals for this pass

No light theme (the current file has one — either port these tokens to a light set or drop
the media query deliberately, don't leave it half-styled). No auth UI. No changes to
schemas, endpoints, or the feed pipeline.

## Checklist before you call it done

- `npm test` and `tsc` clean; `npm run test:integration` unaffected.
- No `config.json`, `channels.json`, database, or generated HLS files added or committed.
- No credentials rendered anywhere — `/api/sources` only reports whether a key exists.
- Every previously working action still fires the same request.
- Work on a branch and summarize modified behavior in the PR description.

## Files

- `Headend.dc.html` — the design reference prototype (all six views, stub data).
- `github.md` — repo association and the screen-to-source map.
