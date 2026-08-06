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

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue containing an exploit, credential, signed download URL, or private
network detail. Include the affected version, reproduction steps, and expected
impact. You should receive an acknowledgement within seven days.
