# Running in Docker

Hardware encoding inside a container is the most common self-hosting failure, so each
case is spelled out. The CPU fallback needs no flags at all and always works.

The published image is `ghcr.io/lancej1011/stremio-channels:latest`. v0.1 publishes
`linux/amd64`; ARM images will follow after native dependency and encoder validation.

## Docker Compose (recommended)

```bash
mkdir -p config data
cp channels.example.json config/channels.json
cp .env.example .env
$EDITOR .env
docker compose up -d
```

For TorBox, prefer the isolated agent described below. Legacy installations may set
`TORBOX_API_KEY`; other providers may use `STREAM_ADDON_URL`. Configuration lives in
`./config`, schedules and caches live in `./data`, and both survive image upgrades.
The default port binding is loopback-only, and stays that way whatever else you configure:
the editor is never meant to be published, and a tunnel daemon runs on the host, not in
the container.

Upgrade without touching those volumes:

```bash
docker compose pull
docker compose up -d
```

### Isolated TorBox credential agent

```bash
mkdir -p secrets
node -e "require('fs').writeFileSync('secrets/debrid_agent_token', require('crypto').randomBytes(32).toString('base64url'), {mode:0o600})"
$EDITOR secrets/torbox_api_key
chmod 600 secrets/torbox_api_key secrets/debrid_agent_token
docker compose -f compose.yaml -f compose.agent.yaml up -d
```

The overlay starts a private, authenticated agent with no host port. Only that container
receives `torbox_api_key`; Headend receives a separate local capability token. Do not also
set `TORBOX_API_KEY` in `.env`.
Also protect a populated legacy `.env` with `chmod 600 .env`; Docker Compose does not do
that automatically.

To build the checked-out source instead, run `docker compose build --pull` followed by
`docker compose up -d`.

## HTTPS for another device

Stremio requires HTTPS for addon URLs that are not on `127.0.0.1`. Keep the container on
loopback and use Tailscale Serve inside your private tailnet:

```bash
tailscale serve --bg 7654
tailscale serve status
```

Set `PUBLIC_BASE_URL` in `.env` to the reported `https://...ts.net` origin, recreate the
container, and open `<that-origin>/watch` in Headend or install
`<that-origin>/manifest.json` in Stremio. Never publish port 7654 directly.

For a device that cannot join the tailnet, add an `ACCESS_TOKEN` to `.env` and use
`tailscale funnel --bg 7654` instead. The install URL then carries the token as its first
path segment; use `<that-origin>/<token>/watch` for Headend. The editor remains unreachable
through the tunnel. A container has no
`config.json` mounted, so set `TRUSTED_HOSTS` by environment as well if you administer it
from anywhere but the host itself. See the README's
[Watching from other devices](README.md#watching-from-other-devices) for the full setup.

## Manual runs and hardware acceleration

The commands below are alternatives to Compose when device passthrough needs tuning.

## CPU (works everywhere)

```bash
docker run -d --name channels \
  -p 127.0.0.1:7654:7654 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e STREAM_ADDON_URL="https://torrentio.strem.fun/YOUR-CONFIG/manifest.json" \
  -e PUBLIC_BASE_URL="http://127.0.0.1:7654" \
  -e ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true \
  ghcr.io/lancej1011/stremio-channels:latest
```

`PUBLIC_BASE_URL` is the URL Stremio receives. Keep the localhost value for a same-host
client; use the Tailscale HTTPS origin for any other device.

## NVIDIA / NVENC

Requires the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host.

```bash
docker run -d --name channels \
  --gpus all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video \
  -p 127.0.0.1:7654:7654 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e STREAM_ADDON_URL="..." \
  -e PUBLIC_BASE_URL="http://127.0.0.1:7654" \
  -e ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true \
  ghcr.io/lancej1011/stremio-channels:latest
```

`NVIDIA_DRIVER_CAPABILITIES` must include `video`. Without it the driver loads but NVENC
is missing, encoder detection quietly falls back to CPU, and you will wonder why the GPU
is idle.

## Intel QuickSync / VAAPI

```bash
docker run -d --name channels \
  --device /dev/dri:/dev/dri \
  -p 127.0.0.1:7654:7654 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e STREAM_ADDON_URL="..." \
  -e PUBLIC_BASE_URL="http://127.0.0.1:7654" \
  -e ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true \
  ghcr.io/lancej1011/stremio-channels:latest
```

If the container user cannot open `/dev/dri/renderD128`, add `--group-add` with the
host's `render` group id (`getent group render | cut -d: -f3`).

## Verifying which encoder was chosen

```bash
docker logs channels | grep -i encoder
```

Expect `using hardware encoder h264_nvenc` (or `_qsv` / `_vaapi`). Seeing
`using software encoder libx264` means the device was not visible to the container —
detection runs a real test encode, so it never claims hardware it cannot use.

Force a specific one with `-e ENCODER=nvenc` if detection picks wrong.
