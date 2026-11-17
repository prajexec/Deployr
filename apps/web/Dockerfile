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

COPY apps/web ./apps/web

WORKDIR /app/apps/web
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/apps/web/dist /app/dist
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
