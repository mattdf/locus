# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --include=optional --legacy-peer-deps --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build:production

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --include=optional --legacy-peer-deps --no-audit --no-fund
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY SYSTEM_PROMPT.md VISUALIZATION_PROMPT.md SOURCE_REWRITE_PROMPT.md ./
USER node
EXPOSE 8787
CMD ["node", "build/server/index.mjs"]
