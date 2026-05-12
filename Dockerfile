FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4569

# Run as non-root
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js auth.js ./
COPY public ./public

# Tmp upload + persistent users data dirs writable by app user
RUN mkdir -p /tmp/s3-explorer-uploads /data && chown -R app:app /tmp/s3-explorer-uploads /data /app

USER app
EXPOSE 4569
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --header="Host: localhost" http://127.0.0.1:4569/healthz > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
