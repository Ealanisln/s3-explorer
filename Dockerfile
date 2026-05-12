# syntax=docker/dockerfile:1.7
#
# Three stages:
#   deps      — production node_modules only (what ships in the final image)
#   builder   — all deps + tsc -b to produce dist/ and public/dist/
#   runtime   — node:alpine + deps + sources + compiled output
#
# The final image NEVER includes typescript or @types/* — only what runtime needs.

# deps: install production deps + compile better-sqlite3 native binding.
# prebuild-install ships GitHub-hosted binaries that work for most platforms,
# but Alpine musl prebuilds can be missing for some Node versions. We install
# python3/make/g++ as a transient build group so node-gyp's fallback works,
# then `apk del` removes them before this stage's filesystem is copied.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# No pinned apk versions: the .gyp build group is removed in the same RUN and
# never reaches the final image, so pinning would just break on every Alpine bump.
# hadolint ignore=DL3018
RUN apk add --no-cache --virtual .gyp python3 make g++ \
 && npm ci --omit=dev --no-audit --no-fund \
 && apk del .gyp

# builder: only runs `tsc -b` which reads .d.ts. The native sqlite binding is
# never executed here, so --ignore-scripts skips the slow rebuild entirely.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.server.json tsconfig.web.json ./
COPY src ./src
COPY public/src ./public/src
RUN npm run build

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4569

# Run as non-root
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public/dist ./public/dist

# Tmp upload + persistent users data dirs writable by app user
RUN mkdir -p /tmp/s3-explorer-uploads /data && chown -R app:app /tmp/s3-explorer-uploads /data /app

USER app
EXPOSE 4569
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --header="Host: localhost" "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
