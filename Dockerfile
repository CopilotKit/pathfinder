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
COPY --from=build /app/dist/ ./dist/
COPY deploy/copilotkit-docs.yaml ./copilotkit-docs.yaml
COPY deploy/pathfinder-docs.yaml ./pathfinder-docs.yaml
COPY pathfinder.example.yaml ./pathfinder.example.yaml
COPY .env.example ./.env.example
CMD ["node", "dist/cli.js", "serve"]
