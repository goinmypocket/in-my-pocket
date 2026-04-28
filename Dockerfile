# In My Pocket — production image for Fly.io.
#
# Single-stage build: better-sqlite3 needs native compilation, and the
# friends-only deploy doesn't need an aggressively-tiny final image.
# The submodule must be populated in the build context (use
# `fly deploy --local-only` from a laptop where it's initialised, or
# `git submodule update --init` before docker build in CI).

FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm ci && npm run build

ENV NODE_ENV=production \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist \
    PORT=8080

EXPOSE 8080

CMD ["npx", "tsx", "platform/server.ts"]
