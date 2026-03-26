# Base — shared dependencies
FROM node:20-slim AS base
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Dev — source mounted, hot reload via tsx watch
FROM base AS dev
COPY . .
CMD ["npx", "tsx", "watch", "src/index.ts"]

# Prod — compiled JS only
FROM base AS prod
COPY dist/ ./dist/
COPY src/db/schema.sql ./dist/db/schema.sql
CMD ["node", "dist/index.js"]
