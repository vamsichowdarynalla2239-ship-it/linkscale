# ---- Stage 1: Builder ----
FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL for Prisma engine generation
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for Docker layer caching
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package-lock.json* ./apps/api/

RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; \
    else npm install; fi

# Copy application source
COPY . .

# Generate Prisma Client for PostgreSQL production runtime & compile TypeScript
RUN cd apps/api && npx prisma generate --schema=prisma/schema.postgres.prisma
RUN npm run build

# ---- Stage 2: Runner ----
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install runtime OpenSSL (required by Prisma) and curl (required by HEALTHCHECK)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Security hardening: Create unprivileged system group and user
RUN groupadd -r appgroup && useradd -r -g appgroup -s /bin/false appuser

# Copy production artifacts, generated Prisma client, and compiled bundle
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

# Expose service port
EXPOSE 3000

# Healthcheck against lightweight /live probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/live || exit 1

# Run as non-root user
USER appuser

# Start application (sync PostgreSQL schema on boot, then start API server)
WORKDIR /app/apps/api
CMD ["sh", "-c", "/app/node_modules/.bin/prisma db push --schema=prisma/schema.postgres.prisma --skip-generate && node dist/main.js"]
