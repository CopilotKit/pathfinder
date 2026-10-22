# Base — shared dependencies (all deps needed for build)
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Build — compile TypeScript
FROM base AS build
COPY . .
RUN npm run build

# Dev — source mounted, hot reload via tsx watch
FROM base AS dev
COPY . .
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Prod — compiled JS only, fresh slim image with prod deps only
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS prod
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Optional peer dependencies. `npm ci --omit=dev` above intentionally
# SKIPS these (they are declared as peerDependencies, not dependencies),
# so the default prod image is lean. If your pathfinder.yaml uses any of
# the features below, UNCOMMENT the matching line and rebuild — otherwise
# the server will throw a clear "Install <pkg>" error at runtime when that
# feature is first exercised (e.g. embedding.provider: local).
# RUN npm install pdf-parse mammoth        # For type: document (PDF/DOCX)
#
# #88 — `@xenova/transformers` for embedding.provider: local. The CI matrix
# in .github/workflows/publish-docker.yml builds two variants of this image
# from the SAME Dockerfile: the default (slim, arg=false → tags :latest /
# :<ref>) and the `-local` variant (arg=true → tags :latest-local /
# :<ref>-local) which preinstalls the dep below. Default build stays slim.
#
# npm 11 (Node 24) keeps a bare `npm install <pkg>` of a package that is
# already an optional peer as an optional peer, and does not install it.
# `--save-optional` records it as an optional dependency so npm installs
# it. `--omit=dev` keeps dev dependencies out, the same as `npm ci` above.
ARG INCLUDE_LOCAL_EMBEDDINGS=false
RUN if [ "$INCLUDE_LOCAL_EMBEDDINGS" = "true" ]; then \
      npm install --omit=dev --save-optional @xenova/transformers; \
    fi
COPY --from=build /app/dist/ ./dist/
COPY docs/analytics.html ./docs/analytics.html
COPY deploy/copilotkit-docs.yaml ./copilotkit-docs.yaml
COPY deploy/pathfinder-docs.yaml ./pathfinder-docs.yaml
COPY deploy/aimock-docs.yaml ./aimock-docs.yaml
COPY pathfinder.example.yaml ./pathfinder.example.yaml
COPY .env.example ./.env.example
CMD ["node", "dist/cli.js", "serve"]
