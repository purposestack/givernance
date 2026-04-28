# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY . .

# Install dependencies using cache
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Bake the server-side API URL into the Next.js build. `next.config.ts`
# rewrites `/api/v1/:path*` to `${API_URL}/v1/:path*`, and that destination
# string is materialised in `routes-manifest.json` at build time — runtime
# env injection (Kamal `env.clear`) cannot replace it. The default targets
# the local dev API; deployment pipelines override via Kamal `builder.args`.
ARG API_URL=http://localhost:4000
ENV API_URL=$API_URL

# Build all workspace projects
RUN pnpm run -r build

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000
EXPOSE 8000

CMD ["node"]
