# Release security

Releases are built only from `v*` tags. The tag must exactly match the version in
`package.json`; the workflow stops before publishing if it does not.

## One-time repository settings

Verify that the dependency graph, Dependabot alerts and security updates, CodeQL default
setup, secret scanning, push protection, and private vulnerability reporting remain enabled
in GitHub's security settings. CodeQL uses GitHub's extended query suite and analyzes both
remote and local input sources.

Protect `main` and require the CI test/container jobs, CodeQL, and the Security workflow's
secret-history and dependency-review checks. Require review for workflow-file changes and
disallow force pushes to `main` and deletion or movement of release tags.

## Prepare a release

1. Update `package.json` and `CHANGELOG.md` together.
2. Run `npm ci`, `npm test`, `npm run test:integration`, `npm run build`,
   `npm audit --omit=dev`, `npm run licenses:check`, and `npm run workflows:check`.
3. Review the complete diff and confirm no real `.env`, config, channel, database, signed
   media URL, or credential fixture is tracked.
4. Merge through the protected branch, then create a signed, annotated version tag and push
   that tag. Do not build release files on a maintainer workstation and upload them by hand.

Example, after setting up a trusted Git signing key:

```bash
git tag -s v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

## What the workflow publishes

The release workflow independently verifies the source, builds the amd64 container, and
creates:

- a production npm tarball (the package remains private and is not published to npm);
- a reproducible CycloneDX JSON SBOM;
- a production-dependency license inventory;
- the project license and SHA-256 checksums;
- a GHCR image identified by immutable digest.

GitHub's OIDC-backed artifact attestation covers every release file, and a separate
provenance attestation covers the pushed container digest. Workflow actions and the Docker
base image are pinned to immutable commits/digests; Dependabot proposes updates.

After release, download the files and verify both layers:

```bash
sha256sum -c SHA256SUMS
gh attestation verify stremio-channels-0.2.0.tgz --repo Lancej1011/stremio-channels
gh attestation verify headend-v0.2.0-sbom.cdx.json --repo Lancej1011/stremio-channels
```

Review the generated SBOM and license report before announcing the release. Never waive a
secret-scanning finding merely to unblock publishing; rotate the credential and remove it
from history first.
