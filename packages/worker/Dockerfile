# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/worker/package.json packages/worker/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/worker/node_modules ./packages/worker/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @givernance/shared build && pnpm --filter @givernance/worker build

# Stage 3: Production
FROM node:22-alpine AS production
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/worker/dist ./packages/worker/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/worker/package.json ./packages/worker/
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
USER node
CMD ["node", "packages/worker/dist/worker.js"]
