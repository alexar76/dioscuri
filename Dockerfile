# syntax=docker/dockerfile:1
#
# DIOSCURI — one mind, two heavens. Twin community agents for the AICOM ecosystem:
# CASTOR rides Telegram, POLLUX holds Discord; one knowledge base (MNEMOSYNE),
# one shield (AEGIS). Multi-stage build: compile TypeScript in `build`, run a
# lean, non-root prod image in `runtime`.
#
# Runtime state (audit chain, KB cache) lives under /data — declared as a volume
# so the container filesystem can run read-only (see docker-compose.yml).

# ---- Stage 1: build (compile src/ -> dist/) -------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Install deps first for better layer caching. package-lock.json is present in this repo.
COPY package.json package-lock.json ./
RUN npm ci

# Bring in the TypeScript sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime (lean production image) ----------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="DIOSCURI" \
      org.opencontainers.image.description="Twin community agents for the AICOM ecosystem: CASTOR (Telegram) + POLLUX (Discord), one shared knowledge base behind a prompt-injection firewall." \
      org.opencontainers.image.source="https://github.com/alexar76/dioscuri" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0"

# Production deps only — no dev toolchain. Drop the image's bundled npm after
# install so Trivy doesn't flag CRITICAL CVEs in npm's transitive `tar`
# (runtime only needs `node` + /app).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Compiled output + the example config (reference only; the real dioscuri.config.json
# is mounted read-only at runtime, never baked into the image).
COPY --from=build /app/dist ./dist
COPY dioscuri.config.example.json ./

# Persistent state (hash-chained audit log, MNEMOSYNE cache) lives in /data.
# Pre-create it owned by the unprivileged user so the read-only rootfs never matters.
ENV DIOSCURI_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

# Drop root: the process only needs to read /app and write /data.
USER node

# HTTP server (GET /health) — keep in sync with DIOSCURI_HTTP_PORT / docker-compose.
EXPOSE 8790

# Liveness probe via Node's global fetch (Node 22). Non-zero exit on any failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DIOSCURI_HTTP_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
