# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci -w @mailprobe/web; else npm install -w @mailprobe/web; fi
COPY apps/web ./apps/web
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w @mailprobe/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
