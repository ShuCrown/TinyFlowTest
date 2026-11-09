FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
COPY package.json pnpm-lock.yaml vite.config.ts tsconfig.json index.html ./
COPY --from=build /app/dist ./dist
RUN pnpm install --frozen-lockfile && pnpm store prune
EXPOSE 5274
CMD ["sh", "-c", "pnpm exec vite preview --host 0.0.0.0 --port \"${WEB_PORT:-5274}\" --strictPort"]