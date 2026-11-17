FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@12.21.0

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/router/package.json ./apps/router/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm --filter @deployservice/shared build
RUN pnpm --filter @deployservice/api build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

RUN npm install -g pnpm@12.21.0

COPY --from=builder /app /app

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["node", "dist/index.js"]
