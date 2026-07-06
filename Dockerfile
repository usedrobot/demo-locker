# --- Base ---
FROM node:22-alpine AS base
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
WORKDIR /app/packages/api
CMD ["npx", "tsx", "src/server.ts"]

# --- Web build ---
FROM base AS web-build
COPY packages/web packages/web
WORKDIR /app/packages/web
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
WORKDIR /app/packages/api
ENV DATA_DIR=/data
ENV WEB_DIST=../web/dist
VOLUME /data
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
