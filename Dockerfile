FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package-lock.json ./
RUN node -e 'const fs=require("node:fs");const root=require("./package-lock.json").packages[""];fs.writeFileSync("package.json",JSON.stringify(root))'
RUN --mount=type=cache,target=/root/.npm npm ci --include=optional --legacy-peer-deps --no-audit --no-fund
COPY . .
RUN npm run build:production

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package-lock.json ./
RUN node -e 'const fs=require("node:fs");const root=require("./package-lock.json").packages[""];fs.writeFileSync("package.json",JSON.stringify(root))'
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --include=optional --legacy-peer-deps --no-audit --no-fund
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/SYSTEM_PROMPT.md ./SYSTEM_PROMPT.md
USER node
EXPOSE 8787
CMD ["node", "build/server/index.mjs"]
