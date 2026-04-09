# Contributing to Givernance

Thank you for your interest in contributing to Givernance, the open-source NPO platform.

## Quick Start

One command to get everything running:

```bash
git clone git@github.com:Onigam/givernance.git
cd givernance
pnpm install && pnpm docker:up && pnpm build
```

That's it. You now have:
- **Dependencies** installed across all packages
- **Infrastructure** running (PostgreSQL, Redis, Keycloak) via Docker Compose
- **All packages** built and ready

### Prerequisites

- **Node.js 22+** (see `.nvmrc` for exact version)
- **pnpm 9+** (`corepack enable` or `npm i -g pnpm`)
- **Docker & Docker Compose**

### Common Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all dependencies |
| `pnpm dev` | Start all packages in watch mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run test suite |
| `pnpm lint` | Check code quality (Biome) |
| `pnpm lint:fix` | Auto-fix lint issues |
| `pnpm typecheck` | TypeScript type checking across all packages |
| `pnpm docker:up` | Start infra services (PG, Redis, Keycloak) |
| `pnpm docker:down` | Stop infra services |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Run database migrations |

## Development Workflow

### 1. Pick an Issue

All work is tracked via [GitHub Issues](https://github.com/Onigam/givernance/issues). Issues are organized by milestone (Phase 0-4) and labeled by module, type, and priority.

### 2. Branch Naming

Create a branch from `main` using this pattern:

```
feature/GIV-<issue-number>-short-description
```

Examples:
- `feature/GIV-15-monorepo-scaffolding`
- `feature/GIV-25-donations-api`
- `fix/GIV-42-pagination-off-by-one`

### 3. Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`

**Scopes:** `api`, `shared`, `worker`, `migrate`, `infra`, `auth`, `db`, `ci`

Examples:
- `feat(api): add SEPA recurring donation endpoint`
- `fix(shared): correct UUIDv7 generation for PostgreSQL`
- `chore(ci): add biome lint to GitHub Actions`
- `test(worker): add BullMQ job retry tests`

### 4. Pull Requests

- Open a PR against `main`
- Reference the issue: `Closes #<issue-number>`
- Fill in the PR template (auto-loaded from `.github/PULL_REQUEST_TEMPLATE.md`)
- Ensure all CI checks pass (lint, typecheck, build, tests)
- Request review from at least one maintainer

### 5. Code Review

- All PRs require at least 1 approval
- Address review comments as new commits (do not force-push during review)
- Squash merge into `main`

## Code Quality

### Biome (Lint + Format)

We use [Biome](https://biomejs.dev/) for linting and formatting — it replaces ESLint + Prettier with a single, fast tool.

```bash
# Check (lint + format)
pnpm lint

# Auto-fix
pnpm lint:fix

# Format only
pnpm format
```

Config is in `biome.json`. Rules:
- **TypeScript strict** — no `any`, no unused variables
- **Organize imports** — automatic sort on `lint:fix`
- **Double quotes, 2-space indent, 100 char line width**

## Project Structure

```
givernance/
├── packages/
│   ├── api/          # Fastify backend (TypeScript)
│   ├── shared/       # Shared types, schemas, validators
│   ├── worker/       # BullMQ background jobs
│   └── migrate/      # Database migrations + data import CLI
├── docs/             # Architecture decisions, specs, docs
├── .github/          # CI workflows, issue/PR templates
├── docker-compose.yml  # Local infra (PG, Redis, Keycloak)
├── biome.json        # Lint + format config
└── tsconfig.base.json  # Shared TypeScript config
```

## Architecture

See [docs/02-reference-architecture.md](docs/02-reference-architecture.md) for the full architecture decision record.

Key decisions:
- **Backend:** TypeScript modular monolith (Fastify)
- **Database:** PostgreSQL 16 with Row-Level Security for multi-tenancy
- **ORM:** Drizzle ORM
- **Auth:** Keycloak (OIDC)
- **Messaging:** NATS + transactional outbox
- **Jobs:** BullMQ + Redis

## Questions?

Open a [Discussion](https://github.com/Onigam/givernance/discussions) or reach out to the maintainers.
