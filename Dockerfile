# syntax=docker/dockerfile:1

# ---- Build stage -----------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the production bundle into dist/.
COPY . .
RUN npm run build

# ---- Production stage ------------------------------------------------------
FROM nginx:alpine

# Serve the built SPA bundle on internal port 80.
COPY --from=builder /app/dist /usr/share/nginx/html

# Custom SPA-aware nginx configuration (try_files fallback to index.html).
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
