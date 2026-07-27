# --- Base ---
# better-sqlite3 ships glibc prebuilds only; alpine/musl would compile from
# source and need a toolchain in the image.
FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/player/package.json packages/player/
RUN npm install

# --- Player bundle (embed.js) ---
FROM base AS player-build
COPY packages/player packages/player
WORKDIR /app/packages/player
RUN npm run build

# --- API ---
FROM base AS api
COPY packages/api packages/api
COPY --from=player-build /app/packages/player/dist packages/player/dist
COPY docs/openapi.json docs/openapi.json
WORKDIR /app/packages/api
CMD ["npx", "tsx", "src/server.ts"]

# --- Web build ---
FROM base AS web-build
COPY packages/web packages/web
WORKDIR /app/packages/web
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- Web serve ---
FROM nginx:alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80

# --- Standalone web build (same-origin API) ---
FROM base AS standalone-web-build
COPY packages/web packages/web
WORKDIR /app/packages/web
ENV VITE_API_URL=""
RUN npm run build

# --- Standalone: API + web + embedded db, one container, one volume ---
FROM base AS standalone
COPY packages/api packages/api
COPY --from=standalone-web-build /app/packages/web/dist packages/web/dist
COPY --from=player-build /app/packages/player/dist packages/player/dist
COPY docs/openapi.json docs/openapi.json
WORKDIR /app/packages/api
ENV DATA_DIR=/data
ENV WEB_DIST=../web/dist
VOLUME /data
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
