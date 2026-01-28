# Multi-architecture Dockerfile for MapScraper Pro
# Supports: linux/amd64, linux/arm64, linux/arm/v7

FROM node:20-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache libc6-compat python3 make g++

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

# Expose port
EXPOSE 5000

# Development command
CMD ["npm", "run", "dev"]

# Production build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Production image
FROM node:20-alpine AS production

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mapscraper
USER mapscraper

EXPOSE 5000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
