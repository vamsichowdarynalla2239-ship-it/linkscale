# ---- Stage 1: Builder ----
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package-lock.json* ./apps/api/

RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile; \
    else npm install; fi

# Copy application source
COPY . .

# Generate Prisma client and compile TypeScript
RUN cd apps/api && npx prisma generate
RUN npm run build

# Install production dependencies only
RUN npm prune --production

# ---- Stage 2: Runner ----
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Security hardening: Create unprivileged system group and user
RUN groupadd -r appgroup && useradd -r -g appgroup -s /bin/false appuser

# Copy production artifacts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

# Expose service port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/live || exit 1

# Run as non-root user
USER appuser

# Start application
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
