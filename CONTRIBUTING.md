# Contributing

## Development

Use Node.js 22 or later, plus `ffmpeg` and `ffprobe` on `PATH`.

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm run build
```

The integration suite runs real CPU encoders and takes a few minutes. Keep
credentials and personal `config.json`, `channels.json`, `.env`, database, and HLS
files out of commits and test fixtures.

## Pull requests

Create a focused branch, include tests for behavior changes, and describe any
configuration or compatibility impact. Pull requests must pass CI before merge.

By contributing, you agree that your contribution is licensed under the MIT
License.
