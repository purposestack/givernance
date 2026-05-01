## ADR-011: Layered Service Architecture over MVC for Frontend

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect)

### Context

Givernance's frontend is a Next.js 16 App Router application (React 19, TypeScript) consuming a Fastify 5 REST API (ADR-002). The backend already enforces a clear modular monolith structure (ADR-001) with TypeBox schemas, Drizzle ORM, and PostgreSQL RLS. The frontend needs an equivalent architectural pattern that:

1. Provides clean separation of concerns between API communication, data shaping, domain logic orchestration, and rendering
2. Works naturally with React Server Components (RSC) and the App Router's file-based routing
3. Supports two distinct execution contexts — server-side (RSC, route handlers) and client-side (interactive components) — each with different auth token forwarding mechanisms
4. Avoids redundant abstraction layers that duplicate what the framework already provides

The classical MVC pattern was evaluated and found to be a poor fit for a React/Next.js App Router frontend.

### Decision

Use a **4-layer service architecture** for the Next.js frontend:

```
┌─────────────────────────────────────────────────┐
│  UI Layer                                       │
│  src/app/ (pages, layouts, route segments)       │
│  src/components/ (reusable React components)     │
│  ── renders data, delegates all API calls ──     │
├─────────────────────────────────────────────────┤
│  Services Layer                                  │
│  src/services/ (domain-specific orchestration)   │
│  ── class-based, ApiClient injected via ctor ──  │
│  ── e.g. DonationService, ContactService ──      │
├─────────────────────────────────────────────────┤
│  Domain Models Layer                             │
│  src/models/ (TypeScript interfaces)             │
│  ── frontend-specific shapes ──                  │
│  ── dates as ISO strings, not Date objects ──    │
├─────────────────────────────────────────────────┤
│  API Client Layer                                │
│  src/lib/api/ (typed fetch wrapper)              │
│  ── JWT from httpOnly cookies (server) ──        │
│  ── credentials: 'include' (client) ──           │
│  ── RFC 9457 error parsing ──                    │
└─────────────────────────────────────────────────┘
```

**State management** (part of this decision):

- **TanStack Query v5** for server data caching, deduplication, background refetching, and optimistic updates in Client Components
- **React Context** for cross-cutting concerns only: auth state, feature flags (`18-feature-flags.md`), AI mode (`13-ai-modes.md`)
- **No global state library** (Redux, Zustand, Jotai) — Server Components eliminate most client-side state; remaining interactive state is local to component trees

### Layer Responsibilities

**1. API Client (`src/lib/api/`)**

Two factory functions produce a typed fetch wrapper:

- `createServerApiClient()` — used in Server Components and route handlers; reads JWT from `cookies()` (Next.js `next/headers`)
- `createClientApiClient()` — used in Client Components; sends `credentials: 'include'` for browser-managed httpOnly cookies

Both factories share the same interface: typed `get<T>()`, `post<T>()`, `put<T>()`, `patch<T>()`, `delete<T>()` methods with automatic RFC 9457 error parsing into a structured `ApiError` type. Base URL is configured via `NEXT_PUBLIC_API_URL` (client, must point to public gateway/reverse proxy — never an internal service address) and `API_URL` (server, internal network — e.g., `http://api:8080`).

**Security requirements for the API Client layer:**

- **JWT cookie attributes**: Authentication tokens are stored in `httpOnly` + `Secure` + `SameSite=Strict` cookies. `SameSite=Strict` (not `Lax`) is required because `GET`-based state reads could leak data via cross-origin navigation.
- **CSRF protection**: The client API client attaches a CSRF token (double-submit cookie pattern) as an `X-CSRF-Token` header on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). The server validates the token matches the value in the CSRF cookie.
- **PII in error responses**: RFC 9457 error details parsed by the API Client must not be logged to browser console or forwarded to error tracking services if they contain PII. Error display uses only the `title` and `detail` fields through sanitized UI components.
- **TanStack Query cache hygiene**: The in-memory query cache may hold PII (donor names, emails, financial data). `gcTime` must be configured to minimize PII retention, and the cache must be explicitly cleared on logout via `queryClient.clear()`.

**2. Domain Models (`src/models/`)**

Frontend-specific TypeScript interfaces that represent API response shapes. These are **not** copies of the Drizzle schema from `@givernance/shared` — they reflect the serialized JSON contract:

- Dates are `string` (ISO 8601), not `Date`
- Monetary amounts are `number` (cents) or `string` (formatted), depending on the endpoint
- Nested relations are flattened or omitted per the API's response envelope

Models are pure types with no runtime code — they exist solely for type safety across services and components. See ADR-013 for the import boundary enforcement that ensures `packages/web` never imports Drizzle ORM types from `@givernance/shared/schema`.

**3. Services (`src/services/`)**

Class-based services with `ApiClient` injected via the constructor:

```typescript
class DonationService {
  constructor(private api: ApiClient) {}
  async list(orgId: string, filters: DonationFilters): Promise<PaginatedResponse<Donation>> { ... }
  async getById(orgId: string, id: string): Promise<Donation> { ... }
  async create(orgId: string, data: CreateDonationInput): Promise<Donation> { ... }
}
```

Constructor injection enables the same service class to work in both execution contexts — the caller provides the appropriate `ApiClient` factory. Services handle domain-specific orchestration: composing multiple API calls, transforming responses, and encapsulating business rules that are purely presentational (e.g., computing a donor's lifetime value from paginated donation history for a dashboard widget).

**4. UI (`src/app/` + `src/components/`)**

- `src/app/` — Next.js App Router route segments (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`). Server Components by default; fetch data via services with `createServerApiClient()`
- `src/components/` — reusable React components. Client Components that need data use TanStack Query hooks wrapping service calls with `createClientApiClient()`

### Why MVC Was Rejected

| MVC Layer | Next.js App Router Equivalent | Problem |
|---|---|---|
| **Controller** | Route segments (`page.tsx`, `layout.tsx`, `route.ts`) already dispatch requests based on URL — the App Router **is** the controller | Adding a controller layer creates a redundant dispatch abstraction over file-based routing |
| **View** | React components **are** the view — JSX is the template language | No template engine to abstract; a "View" layer separate from components is meaningless in React |
| **Model** | No ORM on the frontend — there is no local database to model | "Model" degenerates into API call wrappers, which is exactly what the Services + API Client layers provide with clearer naming |

MVC was designed for server-rendered applications where the controller receives HTTP requests, the model manages persistent state, and the view renders templates. In a React SPA/RSC hybrid, all three responsibilities are already handled by the framework — layering MVC on top adds indirection without adding separation.

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **MVC (Model-View-Controller)** | Familiar pattern, well-documented | Controller redundant with App Router routing, View redundant with React components, Model has no ORM to wrap — all three layers collapse into what the framework already provides | Rejected |
| **MVVM (Model-View-ViewModel)** | Clean data binding, good for complex forms | ViewModel pattern assumes two-way binding (Knockout, Angular) — React's unidirectional data flow makes ViewModels unnecessary; TanStack Query already manages the "ViewModel" concern (cached server state + loading/error states) | Rejected |
| **Feature-sliced architecture** (co-located per feature) | Strong co-location, scales to large teams | Premature for a 1–3 person team; fragments shared services and models across feature directories; harder to enforce consistent API client usage; revisit at Phase 4 if team exceeds 5 engineers | Rejected — revisit at scale |
| **No layering** (pages call `fetch()` directly) | Minimal abstraction, fast to start | JWT forwarding logic duplicated in every page/component, no RFC 9457 error handling consistency, no type safety on API responses, impossible to test business logic without rendering components | Rejected |
| **Layered service architecture** | Clean separation matching actual concerns (transport, shape, orchestration, rendering); works with both RSC and Client Components; testable services via DI; no redundant layers | Requires discipline to avoid services becoming "god classes"; slightly more boilerplate than direct fetch | **Selected** |

### Consequences

- ✅ API Client layer centralizes JWT forwarding, base URL configuration, and error parsing — no `fetch()` calls scattered across components
- ✅ Services are testable in isolation by injecting a mock `ApiClient` — no need to render React components to test API orchestration logic
- ✅ Domain Models provide a single source of truth for API response types on the frontend — TypeScript catches shape mismatches at compile time
- ✅ TanStack Query eliminates the need for Redux/Zustand — server state is cached, deduplicated, and background-refreshed without a global store
- ✅ React Context remains minimal (auth, feature flags, AI mode) — avoids the "everything in global state" anti-pattern
- ✅ Constructor injection of `ApiClient` into services makes the server/client boundary explicit — no accidental `cookies()` calls in Client Components
- ⚠️ Services must not grow into god classes — enforce one service per domain aggregate (e.g., `DonationService`, `ContactService`, `CampaignService`), matching the backend module boundaries from ADR-001
- ⚠️ Domain Models in `src/models/` will drift from `@givernance/shared` TypeBox schemas if the API contract changes — mitigate by generating frontend types from OpenAPI spec in Phase 2+
- ⚠️ Feature-sliced architecture should be re-evaluated if the team exceeds 5 engineers or the frontend exceeds ~40 routes (Phase 4+)

---

