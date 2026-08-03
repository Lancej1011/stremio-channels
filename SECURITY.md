# Security policy

## Supported versions

Security fixes are applied to the latest tagged release and the `main` branch.

## Deployment boundary

Stremio Channels v0.1 is for localhost, a trusted LAN, or a private VPN such as
Tailscale. The web editor, operational endpoints, and channel write APIs do not
have built-in authentication. Do not forward port 7654 to the public internet.

Every installation must use credentials owned by its operator. Do not share a
debrid API key, TMDB token, configured addon URL, `.env`, `config.json`, database,
or channel backup in an issue or support request.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue containing an exploit, credential, signed download URL, or private
network detail. Include the affected version, reproduction steps, and expected
impact. You should receive an acknowledgement within seven days.
