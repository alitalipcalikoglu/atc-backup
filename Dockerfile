# Build from this directory: docker build -t atc-backup .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production DB_PATH=/data/backup.db BACKUP_DIR=/data/backups RESTORE_DIR=/data/restores PORT=3017
WORKDIR /app
RUN mkdir -p /data /sources && chown node:node /data && chmod 700 /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY openapi.yaml ./
COPY src ./src
USER node
# Mount each source data volume under /sources/<id> and list it in BACKUP_SOURCES (databases) or BACKUP_TREES (files and directories, packed with the system tar).
VOLUME ["/data"]
EXPOSE 3017
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- --no-check-certificate "$( [ -n "$TLS_CERT_PATH" ] && echo https || echo http )://127.0.0.1:3017/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
