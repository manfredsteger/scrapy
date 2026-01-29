# Multi-architecture Dockerfile for MapScraper Pro
# Supports: linux/amd64, linux/arm64, linux/arm/v7

FROM node:20-alpine AS base

# Install dependencies for native modules and PostgreSQL client
RUN apk add --no-cache libc6-compat python3 make g++ postgresql-client

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
FROM base AS deps
RUN npm ci --legacy-peer-deps

# Development image
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Copy and set entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 5000

# Use entrypoint to run migrations before starting
ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "run", "dev"]

# Production build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Production image
FROM node:20-alpine AS production

# Install PostgreSQL client for migrations
RUN apk add --no-cache postgresql-client

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mapscraper
USER mapscraper

EXPOSE 5000

ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
