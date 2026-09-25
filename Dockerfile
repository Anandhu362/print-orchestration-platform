# ==========================================
# STAGE 1: The Builder (Compiles TypeScript)
# ==========================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install ALL dependencies (including devDependencies like typescript)
RUN npm ci

# Copy the rest of the source code
COPY . .

# Compile TypeScript to JavaScript (Outputs to /dist)
RUN npm run build


# ==========================================
# STAGE 2: The Production Runner (Secure & Lightweight)
# ==========================================
FROM node:22-bookworm-slim

WORKDIR /app

# Force Node.js into production mode and lock the timezone to Dubai (GST)
ENV NODE_ENV=production
ENV TZ=Asia/Dubai

# Expose build metadata into runtime environment
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

# Install essential font support for PDF rasterization & ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install ONLY production dependencies (skips devDependencies)
RUN npm ci --omit=dev

# Copy the compiled Javascript from the Builder stage
COPY --from=builder /app/dist ./dist

# Create authentication cache directory and transfer ownership to node user
RUN mkdir -p /app/auth_session_cache /app/src/config && chown -R node:node /app

# Security: Switch from root to restricted node user
USER node

# Expose the application port
EXPOSE 8080

# Define volume for persistent Baileys session storage
VOLUME ["/app/auth_session_cache"]

# --- Enterprise HTTP Health Check ---
# Probes Express /health directly via Node's native HTTP module (no external dependencies needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Execute the compiled entry point
CMD ["node", "dist/index.js"]