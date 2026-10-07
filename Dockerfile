# Stage Cue Rail — one-click container image
# Node.js 20 + better-sqlite3 (prebuilt binary, no build toolchain needed)
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/cuerail.db \
    SEED_ON_EMPTY=true

WORKDIR /app

# Install production dependencies first for better layer caching
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# Persist SQLite database (WAL sidecar files live alongside it)
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
