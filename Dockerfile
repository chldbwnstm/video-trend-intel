# Video Trend Intel: REST API + web build + scheduled collector in one container.
#
#   docker build -t video-trend-intel .
#   docker run -p 8787:8787 -v "$PWD/data:/app/data" --env-file .env video-trend-intel
#   (or: docker compose up -d)
#
# /app/data (volume) holds the SQLite store, data/export/dataset.json and collector logs. The server loads
# data/export/dataset.json (falling back to a dataset baked into the web build, if any), hot-swaps every new
# export and runs the collector every COLLECT_INTERVAL_MIN minutes (0 disables). Credentialed sources
# (YOUTUBE_API_KEY, ...) activate only when their variables are set (env_file / -e), never baked into the image.
FROM node:22-slim

WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# 1) Dependencies (own layer, reused while manifests and the lockfile are unchanged).
#    Dev dependencies are needed: vite builds the web app and tsx runs the TypeScript server.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/collector/package.json packages/collector/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --include=dev

# 2) Sources + static web build (apps/web/dist).
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build -w @vti/web \
 && mkdir -p /app/data \
 && chown -R node:node /app/data

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    COLLECT_INTERVAL_MIN=180

VOLUME ["/app/data"]
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node (not npm/npx) is PID 1 so SIGTERM reaches the server's graceful shutdown directly.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
