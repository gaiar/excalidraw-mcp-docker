# syntax=docker/dockerfile:1

# --- Builder stage ---
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG EXCALIDRAW_URL=https://excalidraw.com
ARG EXCALIDRAW_EXPORT_ENABLED=false
ARG EXCALIDRAW_SAVE_FILE_ENABLED=true
ARG EXCALIDRAW_FULLSCREEN_ENABLED=false
ENV EXCALIDRAW_URL=${EXCALIDRAW_URL}
ENV EXCALIDRAW_EXPORT_ENABLED=${EXCALIDRAW_EXPORT_ENABLED}
ENV EXCALIDRAW_SAVE_FILE_ENABLED=${EXCALIDRAW_SAVE_FILE_ENABLED}
ENV EXCALIDRAW_FULLSCREEN_ENABLED=${EXCALIDRAW_FULLSCREEN_ENABLED}

RUN pnpm run build:docker

# --- Runtime stage ---
FROM node:20-alpine AS runtime

WORKDIR /app

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Install packages that can't be bundled by esbuild (CJS/native)
RUN npm install --no-save express@5 cors@2 ioredis@5 2>/dev/null

COPY --from=builder /app/dist ./dist

RUN chown -R appuser:appgroup /app

USER appuser

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
