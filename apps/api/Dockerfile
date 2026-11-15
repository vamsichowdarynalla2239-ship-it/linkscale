# ------------------------------------------------------------------------------
# STAGE 1: Builder
# ------------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and Prisma schema
COPY . .

# Generate Prisma Client and build TypeScript bundle
RUN npx prisma generate
RUN npm run build

# ------------------------------------------------------------------------------
# STAGE 2: Production Runner
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript bundle and Prisma artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Run as non-root user for container security hardening
USER node

# Expose HTTP port
EXPOSE 3000

# Default entrypoint runs API server (overridable to worker: ["node", "dist/workers/run-worker.js"])
CMD ["node", "dist/main.js"]

