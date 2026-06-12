ARG NODE_IMAGE=docker.1panel.live/library/node:20-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

FROM base AS origin-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends g++ make pkg-config python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM origin-deps AS origin-builder
ENV NODE_ENV=production
ENV ORIGIN_ENV_FILE=/tmp/origin-empty.env
ENV ORIGIN_DATA_DIR=/tmp/origin-build-data
ENV DB_PATH=/tmp/origin-build-data/qd.sqlite
ENV ADMIN_BOOTSTRAP_USERNAME=build-admin
ENV ADMIN_BOOTSTRAP_PASSWORD=BuildAdminPassword-123
COPY . .
RUN touch /tmp/origin-empty.env \
  && mkdir -p /tmp/origin-build-data \
  && npm run build:workspace-css \
  && npm run build
RUN if [ -f vevdemo-1.0.6/nodejs/package-lock.json ]; then \
    cd vevdemo-1.0.6/nodejs \
    && (npm ci --omit=dev --no-audit --no-fund || true) \
    && (node -e "require.resolve('koa')" \
      || (rm -rf node_modules \
        && npm install --omit=dev --package-lock=false --no-audit --no-fund --registry=https://registry.npmmirror.com \
        && node -e "require.resolve('koa')")); \
  fi
RUN npm prune --omit=dev

FROM base AS origin
ENV NODE_ENV=production
ENV PORT=3000
ENV ORIGIN_ENV_FILE=/app/.env
ENV ORIGIN_DATA_DIR=/var/lib/origin/data
ENV DB_PATH=/var/lib/origin/data/qd.sqlite
COPY --from=origin-builder /app /app
RUN mkdir -p /var/lib/origin/data
EXPOSE 3000
CMD ["npm", "run", "start"]

FROM base AS vevdemo-api
WORKDIR /app/vevdemo-1.0.6/nodejs
COPY vevdemo-1.0.6/nodejs/package.json vevdemo-1.0.6/nodejs/package-lock.json ./
RUN (npm ci --omit=dev --no-audit --no-fund || true) \
  && (node -e "require.resolve('koa')" \
    || (rm -rf node_modules \
      && npm install --omit=dev --package-lock=false --no-audit --no-fund --registry=https://registry.npmmirror.com \
      && node -e "require.resolve('koa')"))
COPY vevdemo-1.0.6/nodejs/ ./
ENV NODE_ENV=production
ENV ORIGIN_ENV_FILE=/app/.env
ENV PORT=3002
ENV VEVDEMO_BACKEND_PORT=3002
EXPOSE 3002
CMD ["node", "index.js"]

FROM base AS vevdemo-fe
WORKDIR /app/vevdemo-1.0.6/fe
COPY vevdemo-1.0.6/fe/package.json vevdemo-1.0.6/fe/package-lock.json ./
RUN (npm ci --include=dev --no-audit --no-fund || true) \
  && (node -e "require.resolve('vite'); require.resolve('http-server')" \
    || (rm -rf node_modules \
      && npm install --include=dev --package-lock=false --no-audit --no-fund --registry=https://registry.npmmirror.com \
      && node -e "require.resolve('vite'); require.resolve('http-server')"))
COPY vevdemo-1.0.6/fe/ ./
WORKDIR /app
RUN mkdir -p /app/scripts
COPY scripts/sync-vevdemo-env.cjs /app/scripts/sync-vevdemo-env.cjs
ENV NODE_ENV=production
ENV ORIGIN_ENV_FILE=/app/.env
ENV VEVDEMO_BASE_PATH=/vevdemo/
EXPOSE 8084
CMD ["sh", "-lc", "node /app/scripts/sync-vevdemo-env.cjs && cd /app/vevdemo-1.0.6/fe && npx vite build --base=\"$VEVDEMO_BASE_PATH\" && npx http-server dist -a 0.0.0.0 -p 8084 -c-1"]
