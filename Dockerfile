FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts
RUN npm run build

FROM node:26-bookworm-slim
WORKDIR /app

# ffmpeg carries the VAAPI and QSV userspace drivers; NVENC comes from the host via the
# NVIDIA container runtime rather than from anything installed here.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY presets ./presets
COPY examples ./examples
COPY channels.example.json config.example.json ./

ENV HOST=0.0.0.0 \
    PORT=7654 \
    DATA_DIR=/data \
    CHANNELS_FILE=/config/channels.json
VOLUME ["/data", "/config"]
EXPOSE 7654

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7654/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
