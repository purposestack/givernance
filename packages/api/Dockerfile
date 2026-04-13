# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @givernance/shared build && pnpm --filter @givernance/api build

# Stage 3: Production
FROM node:22-alpine AS production
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/api/package.json ./packages/api/
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/api/migrations ./packages/api/migrations
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
USER node
EXPOSE 4000
CMD ["node", "packages/api/dist/index.js"]
