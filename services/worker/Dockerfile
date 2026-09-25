# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ==========================================
# STAGE 2: Cloud Run Production Runner
# ==========================================
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Dubai

# Install fonts and tools required for PDF rendering & canvas
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create non-root node execution user
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
