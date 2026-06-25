# Base — shared dependencies (all deps needed for build)
FROM node:20-slim AS base
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
FROM node:20-slim AS prod
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
# RUN npm install @xenova/transformers     # For embedding.provider: local (transformers.js / in-process CPU embeddings)
COPY --from=build /app/dist/ ./dist/
COPY docs/analytics.html ./docs/analytics.html
COPY deploy/copilotkit-docs.yaml ./copilotkit-docs.yaml
COPY deploy/pathfinder-docs.yaml ./pathfinder-docs.yaml
COPY deploy/aimock-docs.yaml ./aimock-docs.yaml
COPY pathfinder.example.yaml ./pathfinder.example.yaml
COPY .env.example ./.env.example
CMD ["node", "dist/cli.js", "serve"]
