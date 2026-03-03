# Contributing to Givernance

Thank you for your interest in contributing to Givernance, the open-source NPO platform.

## Development Workflow

### 1. Pick an Issue

All work is tracked via [GitHub Issues](https://github.com/Onigam/givernance/issues). Issues are organized by milestone (Phase 0-4) and labeled by module, type, and priority.

### 2. Branch Naming

Create a branch from `main` using this pattern:

```
feature/GIV-<issue-number>-short-description
```

Examples:
- `feature/GIV-12-scaffold-go-monorepo`
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

**Scopes:** `auth`, `constituents`, `donations`, `campaigns`, `grants`, `programs`, `volunteers`, `impact`, `finance`, `comms`, `gdpr`, `admin`, `reports`, `migration`, `infra`

Examples:
- `feat(donations): add SEPA recurring donation support`
- `fix(auth): correct JWT expiry validation`
- `chore(infra): update Docker Compose to PG 16.2`
- `test(constituents): add fuzzy match integration tests`

### 4. Pull Requests

- Open a PR against `main`
- Reference the issue: `Closes #<issue-number>`
- Fill in the PR template (auto-loaded from `.github/PULL_REQUEST_TEMPLATE.md`)
- Ensure all CI checks pass (tests, lint, build)
- Request review from at least one maintainer

### 5. Code Review

- All PRs require at least 1 approval
- Address review comments as new commits (do not force-push during review)
- Squash merge into `main`

## Running the Dev Environment

### Prerequisites

- Go 1.23+
- Node.js 20+ / pnpm
- Docker & Docker Compose
- Make

### Quick Start

```bash
# Clone the repo
git clone git@github.com:Onigam/givernance.git
cd givernance

# Start all services
docker compose up -d

# Run backend
make run-api

# Run frontend
cd frontend && pnpm install && pnpm dev

# Run tests
make test
```

### Environment Variables

Copy `.env.example` to `.env` and fill in the required values. Never commit `.env` files.

## Architecture

See [docs/02-reference-architecture.md](docs/02-reference-architecture.md) for the full architecture decision record.

Key decisions:
- **Backend:** Go modular monolith with clean architecture
- **Frontend:** Next.js 15 (App Router) + Tailwind CSS
- **Database:** PostgreSQL 16 with Row-Level Security for multi-tenancy
- **Auth:** Keycloak 24 (OIDC)
- **Messaging:** NATS JetStream + transactional outbox
- **Jobs:** Asynq + Redis

## Questions?

Open a [Discussion](https://github.com/Onigam/givernance/discussions) or reach out to the maintainers.
