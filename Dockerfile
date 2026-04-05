# --- Base ---
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN npm install

# --- API ---
FROM base AS api
COPY packages/api packages/api
WORKDIR /app/packages/api
CMD ["npx", "tsx", "src/index.ts"]

# --- Web build ---
FROM base AS web-build
COPY packages/web packages/web
WORKDIR /app/packages/web
RUN npm run build

# --- Web serve ---
FROM nginx:alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
