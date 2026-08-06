# Security policy

## Supported versions

Security fixes are applied to the latest tagged release and the `main` branch.

## Deployment boundary

With no `accessToken` configured, Stremio Channels has no authentication of any
kind and is for localhost, a trusted LAN, or a private VPN such as Tailscale.
Do not forward port 7654 to the public internet in that state.

Setting `accessToken` makes the standalone viewer, read-only viewer guide, addon and feed endpoints require that secret as
the first path segment, which is what makes an outbound tunnel such as Tailscale
Funnel reasonable for a single operator. The web editor, diagnostics, and channel
write APIs are never published: they answer only to loopback and to the hosts
named in `trustedHosts`, and a request relayed by any reverse proxy is treated as
remote. Anyone holding the token can watch the channels and read the guide/catalog, so
treat the tokenized viewer URL as a password. Rotating it requires updating viewer
bookmarks and reinstalling the addon.

Every installation must use credentials owned by its operator. Do not share a
debrid API key, TMDB token, configured addon URL, `.env`, `config.json`, database,
or channel backup in an issue or support request.

For TorBox, the recommended deployment is `compose.agent.yaml`: the provider key is
mounted only into an authenticated broker with no published port. Headend receives a
separate broker token. Remote viewers receive HLS by default rather than private signed
provider links. Keep `remoteDirectPlay` disabled unless every client is the operator's own
device and the provider explicitly permits that use.

The SQLite database may contain short-lived signed download URLs. Keep the data and config
directories private; Headend requests mode `0700` for its data directory and `0600` for
database and channel files, but shared/FAT-like filesystems may not enforce Unix modes.

Channel guides are untrusted input. Applying one requires a preview confirmation tied to
the exact guide and current lineup. Remote imports are HTTPS-only, validate and pin DNS on
every redirect, and cannot reach private, loopback, link-local, reserved, or metadata
addresses by default. External artwork and automatic catalogue sources are removed or
rejected unless the operator explicitly enables their separate risk switches.

Repeated remote token failures are delayed and forced off keep-alive connections while
retaining the same opaque 404 response. Valid remote tune and playback-allocation requests
are limited per socket address. Direct TorBox and isolated-agent operations have persisted
hourly and UTC-day ceilings; restarting Headend does not reset them. Stream-addon providers
run outside this boundary, so their internal debrid calls cannot be counted here.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue containing an exploit, credential, signed download URL, or private
network detail. Include the affected version, reproduction steps, and expected
impact. You should receive an acknowledgement within seven days.

## Release integrity

CI actions and the container base are pinned to immutable digests. Pull requests receive
dependency review, CodeQL analysis, and full-history secret scanning. Tagged releases
include checksums, a CycloneDX SBOM, a production license inventory, and GitHub keyless
provenance attestations. Verification instructions are in [RELEASING.md](RELEASING.md).
