# Stage 1: Install dependencies
FROM node:26-alpine AS deps
RUN corepack enable
# `sharp` (Epic #286 image pipeline) needs libvips headers available at
# install time so its prebuilt binary can be linked against the running
# libvips. Without this the install falls back to a slow JS path or
# fails outright on alpine.
RUN apk add --no-cache vips-dev
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod=false

# Stage 2: Build
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @givernance/shared build && pnpm --filter @givernance/api build

# Stage 3: Production
FROM node:26-alpine AS production
RUN corepack enable
# Runtime libvips for `sharp` (Epic #286). `vips` (without `-dev`) is the
# minimal runtime; the headers are only required at build time.
RUN apk add --no-cache vips
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
