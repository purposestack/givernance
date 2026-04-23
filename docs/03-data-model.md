# 03 — Data Model

> Last updated: 2026-04-14

---

## 1. Design principles

| Principle | Implementation |
|---|---|
| Multi-tenant isolation | All tenant-owned tables carry `org_id UUID NOT NULL`; enforced via PostgreSQL RLS |
| Immutable audit trail | No physical deletes on financial records; soft-delete with `deleted_at` + `deleted_by` |
| GDPR erasure without corruption | PII stored in erasable `contact_pii` column set; FK references survive erasure as anonymised tombstones |
| Flexible extension | Custom fields stored as `JSONB custom_fields` on all primary entities; validated against org-defined schema at API layer |
| Stable IDs | UUID v7 (time-ordered) for all primary keys — sortable, no sequential guessing |
| Normalised core, flexible edges | Core financial facts fully normalised; relationship metadata (tags, notes, custom fields) in JSONB |

---

## 2. Entity relationship overview

```
See: /diagrams/core-erd.mmd
```

Top-level entity groupings:

```
PARTY (constituents, households, organisations)
  └── GIVING (donations, pledges, installments, funds, allocations)
  └── GRANTS (grants, funder contacts, deliverables)
  └── PROGRAMS (programs, enrollments, service_deliveries, case_notes)
  └── VOLUNTEERS (volunteer_profiles, opportunities, shifts, hour_logs)
  └── IMPACT (indicators, readings)
  └── COMMS (email_sends, receipts, consent_log)
  └── FINANCE (funds, gl_batches, gl_export_lines)
  └── PLATFORM (orgs, users, roles, audit_log, outbox_events, receipt_sequences)
```

---

## 3. Core table definitions

### 3.1 Platform tables

#### `orgs`
```sql
CREATE TABLE orgs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    slug            TEXT UNIQUE NOT NULL,          -- URL slug, e.g. "greenpeace-de"
    name            TEXT NOT NULL,
    country_code    CHAR(2) NOT NULL,              -- ISO 3166-1 alpha-2
    timezone        TEXT NOT NULL DEFAULT 'Europe/Berlin',
    currency_code   CHAR(3) NOT NULL DEFAULT 'EUR',
    charity_reg_no  TEXT,
    plan_id         TEXT NOT NULL DEFAULT 'starter',
    trial_ends_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    suspended_at    TIMESTAMPTZ,
    custom_fields_schema JSONB DEFAULT '{}'::JSONB  -- org-defined custom field definitions
);
```

#### `users`
```sql
CREATE TABLE users (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id            UUID NOT NULL REFERENCES orgs(id),
    keycloak_sub      UUID UNIQUE NOT NULL,           -- KC subject claim
    email             TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    role              TEXT NOT NULL,                 -- see §5 RBAC
    is_active         BOOLEAN NOT NULL DEFAULT true,
    last_login_at     TIMESTAMPTZ,
    -- Self-serve tenant provisioning (migration 0021 / ADR-016)
    first_admin       BOOLEAN NOT NULL DEFAULT false, -- first admin of a self-serve tenant
    provisional_until TIMESTAMPTZ,                    -- non-null => provisional org_admin; dispute window open
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, email),
    CHECK (provisional_until IS NULL OR first_admin = true)
);
```

#### `tenants` lifecycle columns (migration 0021 / ADR-016)

On top of the legacy `orgs`/`tenants` columns, the hybrid onboarding model adds:

```sql
ALTER TABLE tenants
    ADD COLUMN status          VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN ('provisional','active','suspended','archived')),
    ADD COLUMN created_via     VARCHAR(32) NOT NULL DEFAULT 'enterprise'
        CHECK (created_via IN ('self_serve','enterprise','invitation')),
    ADD COLUMN verified_at     TIMESTAMPTZ,
    ADD COLUMN keycloak_org_id TEXT,             -- Keycloak 26 Organization id (bound 1:1)
    ADD COLUMN primary_domain  VARCHAR(255);     -- convenience; source of truth = tenant_domains
```

See [`docs/22-tenant-onboarding.md`](./22-tenant-onboarding.md) §4 for the full spec and `docs/15-infra-adr.md` ADR-016 for the decision.

#### `tenant_domains` (ADR-016)
```sql
CREATE TABLE tenant_domains (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain         VARCHAR(255) NOT NULL CHECK (domain = lower(domain)),
    state          VARCHAR(32)  NOT NULL DEFAULT 'pending_dns'
                   CHECK (state IN ('pending_dns','verified','revoked')),
    dns_txt_value  VARCHAR(128) NOT NULL,
    verified_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Partial unique: a domain is globally unique while active; revoked rows free the slot.
CREATE UNIQUE INDEX tenant_domains_active_domain_uniq
    ON tenant_domains (domain) WHERE state <> 'revoked';
```

Personal/consumer email domains (gmail, outlook, proton, …) are rejected at the API validator layer via `@givernance/shared/constants/personal-email-domains`. Reserved tenant slugs (`admin`, `api`, `login`, …) live in `@givernance/shared/constants/reserved-slugs`.

#### `tenant_admin_disputes` (ADR-016, provisional-admin grace period)
```sql
CREATE TABLE tenant_admin_disputes (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    disputer_id          UUID NOT NULL REFERENCES users(id),
    provisional_admin_id UUID NOT NULL REFERENCES users(id),
    reason               TEXT,
    resolution           VARCHAR(32)
                         CHECK (resolution IS NULL OR
                                resolution IN ('kept','replaced','escalated_to_support')),
    resolved_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (disputer_id <> provisional_admin_id)
);
-- One open dispute per tenant at most; closed disputes (resolution set) don't block a new one.
CREATE UNIQUE INDEX tenant_admin_disputes_one_open_per_tenant
    ON tenant_admin_disputes (org_id) WHERE resolution IS NULL;
```

#### `audit_log`
```sql
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    user_id         UUID,                          -- NULL for system actions
    action          TEXT NOT NULL,                 -- e.g. 'donation.created'
    entity_type     TEXT NOT NULL,
    entity_id       UUID NOT NULL,
    before_state    JSONB,
    after_state     JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
-- Monthly partitions; Glacier archive after 12 months
```

#### `outbox_events` (transactional outbox)

> **Implementation note**: This table was originally designed as `domain_events` with a `published` boolean. The implemented table is named `outbox_events` with a `status` enum (`pending` / `completed` / `failed`) and a `processed_at` timestamp, which provides richer operational visibility.

```sql
CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    tenant_id       UUID NOT NULL,                    -- org_id (named tenant_id for clarity)
    type            TEXT NOT NULL,                     -- e.g. 'DonationCreated', 'ConstituentUpdated'
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed')),
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON outbox_events (status, created_at) WHERE status = 'pending';
```

The `packages/relay` microservice polls this table using `SELECT ... FOR UPDATE SKIP LOCKED` and enqueues to BullMQ. See [02-reference-architecture.md §7.1](./02-reference-architecture.md) for the full flow.

#### `receipt_sequences` (atomic receipt numbering)

```sql
CREATE TABLE receipt_sequences (
    org_id          UUID NOT NULL REFERENCES orgs(id),
    fiscal_year     INTEGER NOT NULL,
    next_val        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, fiscal_year)
);
```

Used by the receipt generation worker to produce gapless, race-condition-safe receipt numbers via:

```sql
INSERT INTO receipt_sequences (org_id, fiscal_year, next_val)
VALUES ($1, $2, 1)
ON CONFLICT ON CONSTRAINT receipt_sequences_pkey
DO UPDATE SET next_val = receipt_sequences.next_val + 1
RETURNING next_val;
```

Receipt numbers follow the format `REC-YYYY-NNNN` (zero-padded). Uniqueness is enforced by a separate constraint on the `receipts` table: `UNIQUE(org_id, fiscal_year, receipt_number)`.

---

### 3.2 Party / Constituent tables

#### `constituents`
```sql
CREATE TABLE constituents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    type            TEXT NOT NULL CHECK (type IN ('individual','organisation','household')),
    -- PII block (erasable)
    first_name      TEXT,
    last_name       TEXT,
    preferred_name  TEXT,
    salutation      TEXT,
    email_primary   TEXT,
    email_secondary TEXT,
    phone_primary   TEXT,
    phone_mobile    TEXT,
    -- Address
    addr_line1      TEXT,
    addr_line2      TEXT,
    addr_city       TEXT,
    addr_postcode   TEXT,
    addr_country    CHAR(2),
    -- Classification
    is_donor        BOOLEAN NOT NULL DEFAULT false,
    is_beneficiary  BOOLEAN NOT NULL DEFAULT false,
    is_volunteer    BOOLEAN NOT NULL DEFAULT false,
    is_staff        BOOLEAN NOT NULL DEFAULT false,
    is_board_member BOOLEAN NOT NULL DEFAULT false,
    -- Communication preferences
    do_not_email    BOOLEAN NOT NULL DEFAULT false,
    do_not_mail     BOOLEAN NOT NULL DEFAULT false,
    do_not_contact  BOOLEAN NOT NULL DEFAULT false,
    preferred_lang  CHAR(2) DEFAULT 'en',
    -- Lifecycle
    lifecycle_stage TEXT DEFAULT 'prospect',       -- prospect, first_time, repeat, lapsed, major_donor
    source          TEXT,                          -- how they entered the system
    -- Extension
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    -- Audit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    deleted_by      UUID,
    erased_at       TIMESTAMPTZ,                   -- GDPR erasure timestamp
    CONSTRAINT constituent_org_idx UNIQUE (org_id, id)
);

-- Fuzzy search index
CREATE INDEX constituent_trgm_name ON constituents
    USING gin ((first_name || ' ' || COALESCE(last_name,'')) gin_trgm_ops)
    WHERE deleted_at IS NULL AND erased_at IS NULL;
CREATE INDEX constituent_email_idx ON constituents (org_id, email_primary)
    WHERE deleted_at IS NULL;
```

#### `households`
```sql
CREATE TABLE households (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    name            TEXT NOT NULL,                -- e.g. "The Smith Family"
    primary_contact_id UUID REFERENCES constituents(id),
    addr_line1      TEXT,
    addr_city       TEXT,
    addr_postcode   TEXT,
    addr_country    CHAR(2),
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE household_members (
    household_id    UUID NOT NULL REFERENCES households(id),
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    role            TEXT,                         -- primary, secondary, child
    PRIMARY KEY (household_id, constituent_id)
);
```

#### `constituent_relationships`
```sql
CREATE TABLE constituent_relationships (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    constituent_a   UUID NOT NULL REFERENCES constituents(id),
    constituent_b   UUID NOT NULL REFERENCES constituents(id),
    relationship_type TEXT NOT NULL,              -- spouse, sibling, employer, board_member_of
    is_primary      BOOLEAN DEFAULT false,        -- primary contact at org
    start_date      DATE,
    end_date        DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT no_self_rel CHECK (constituent_a <> constituent_b)
);
```

#### `gdpr_consent_log`
```sql
CREATE TABLE gdpr_consent_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    basis           TEXT NOT NULL,                -- consent, legitimate_interest, contract, legal_obligation
    scope           TEXT NOT NULL,                -- email_marketing, sms, postal, data_processing
    channel         TEXT,                         -- web_form, phone, paper, import
    consented       BOOLEAN NOT NULL,
    consent_text    TEXT,
    ip_address      INET,
    recorded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.3 Giving tables

#### `funds`
```sql
CREATE TABLE funds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    name            TEXT NOT NULL,
    code            TEXT NOT NULL,               -- short code, e.g. "GEN", "RESTRICTED-EU2024"
    type            TEXT NOT NULL CHECK (type IN ('unrestricted','restricted','endowment','capital')),
    nominal_code    TEXT,                        -- mapping to accounting chart of accounts
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, code)
);
```

#### `donations`
```sql
CREATE TABLE donations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    household_id    UUID REFERENCES households(id),
    campaign_id     UUID REFERENCES campaigns(id),
    -- Amount
    amount          NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    type            TEXT NOT NULL CHECK (type IN ('cash','in_kind','stock','matched')),
    -- Dates
    received_date   DATE NOT NULL,
    posted_date     DATE,
    -- Payment
    payment_method  TEXT,                        -- card, bank_transfer, sepa_dd, cash, cheque, paypal
    payment_ref     TEXT,                        -- payment gateway transaction ID
    payment_gateway TEXT,                        -- stripe, mollie, manual
    sepa_mandate_ref TEXT,
    -- Status
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared','refunded','failed')),
    is_anonymous    BOOLEAN NOT NULL DEFAULT false,
    is_gift_aided   BOOLEAN NOT NULL DEFAULT false,
    gift_aid_claimed_at DATE,
    -- Receipt
    receipt_id      UUID REFERENCES receipts(id),
    receipt_sent_at TIMESTAMPTZ,
    -- Lifecycle
    pledge_id       UUID REFERENCES pledges(id), -- set if this payment satisfies a pledge installment
    in_kind_description TEXT,
    in_kind_value   NUMERIC(14,2),
    notes           TEXT,
    source_code     TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    -- Batch
    gl_batch_id     UUID REFERENCES gl_batches(id),
    -- Audit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES users(id),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX donation_constituent_idx ON donations (org_id, constituent_id, received_date DESC);
CREATE INDEX donation_campaign_idx ON donations (org_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX donation_status_idx ON donations (org_id, status, received_date);
```

#### `donation_allocations` (split across funds)
```sql
CREATE TABLE donation_allocations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    donation_id     UUID NOT NULL REFERENCES donations(id),
    fund_id         UUID NOT NULL REFERENCES funds(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Invariant: SUM(allocations.amount) = donation.amount (enforced by API)
```

#### `pledges`
```sql
CREATE TABLE pledges (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    campaign_id     UUID REFERENCES campaigns(id),
    total_amount    NUMERIC(14,2) NOT NULL CHECK (total_amount > 0),
    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    installment_amount NUMERIC(14,2),
    frequency       TEXT NOT NULL CHECK (frequency IN ('monthly','quarterly','annual','one_off')),
    start_date      DATE NOT NULL,
    end_date        DATE,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled','failed')),
    payment_method  TEXT,
    sepa_mandate_ref TEXT,
    stripe_sub_id   TEXT,
    fund_id         UUID REFERENCES funds(id),
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `pledge_installments`
```sql
CREATE TABLE pledge_installments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    pledge_id       UUID NOT NULL REFERENCES pledges(id),
    due_date        DATE NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','paid','failed','skipped','cancelled')),
    donation_id     UUID REFERENCES donations(id),  -- set when payment captured
    attempt_count   SMALLINT NOT NULL DEFAULT 0,
    last_attempted_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `soft_credits`
```sql
CREATE TABLE soft_credits (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    donation_id     UUID NOT NULL REFERENCES donations(id),
    constituent_id  UUID NOT NULL REFERENCES constituents(id), -- who gets credit
    amount          NUMERIC(14,2) NOT NULL,
    credit_type     TEXT NOT NULL DEFAULT 'solicitor', -- solicitor, household_member, matched
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.4 Campaign tables

#### `campaigns`
```sql
CREATE TABLE campaigns (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    parent_id       UUID REFERENCES campaigns(id),  -- hierarchy
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,                  -- email, direct_mail, event, digital, phone
    status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed','cancelled')),
    start_date      DATE,
    end_date        DATE,
    goal_amount     NUMERIC(14,2),
    goal_donors     INT,
    expected_cost   NUMERIC(14,2),
    description     TEXT,
    source_code     TEXT UNIQUE,                    -- printed on response coupons / UTM
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.5 Grant tables

#### `grants`
```sql
CREATE TABLE grants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    funder_id       UUID NOT NULL REFERENCES constituents(id), -- funder is a constituent (org type)
    name            TEXT NOT NULL,
    reference       TEXT,                           -- funder's reference number
    amount          NUMERIC(14,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'EUR',
    fund_id         UUID REFERENCES funds(id),
    status          TEXT NOT NULL DEFAULT 'prospecting'
        CHECK (status IN ('prospecting','applied','awarded','active','reporting','closed','rejected')),
    applied_date    DATE,
    awarded_date    DATE,
    start_date      DATE,
    end_date        DATE,
    next_report_due DATE,
    restrictions    TEXT,
    notes           TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `grant_tranches`
```sql
CREATE TABLE grant_tranches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    grant_id        UUID NOT NULL REFERENCES grants(id),
    tranche_no      SMALLINT NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,
    due_date        DATE,
    received_date   DATE,
    donation_id     UUID REFERENCES donations(id), -- when tranche received, creates a donation
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `grant_deliverables`
```sql
CREATE TABLE grant_deliverables (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    grant_id        UUID NOT NULL REFERENCES grants(id),
    description     TEXT NOT NULL,
    due_date        DATE,
    completed_date  DATE,
    owner_id        UUID REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','overdue')),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.6 Program tables

#### `programs`
```sql
CREATE TABLE programs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    name            TEXT NOT NULL,
    type            TEXT,                           -- counselling, food_bank, shelter, education
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
    capacity        INT,
    fund_id         UUID REFERENCES funds(id),      -- primary funder
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `enrollments`
```sql
CREATE TABLE enrollments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    program_id      UUID NOT NULL REFERENCES programs(id),
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    worker_id       UUID REFERENCES users(id),      -- assigned caseworker
    start_date      DATE NOT NULL,
    end_date        DATE,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','waitlist','closed','referred','disengaged')),
    outcome_type    TEXT,                           -- completed, referred_out, disengaged, deceased
    outcome_notes   TEXT,
    referral_source TEXT,
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `service_deliveries`
```sql
CREATE TABLE service_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    enrollment_id   UUID NOT NULL REFERENCES enrollments(id),
    program_id      UUID NOT NULL REFERENCES programs(id),
    delivered_by    UUID REFERENCES users(id),
    delivery_date   DATE NOT NULL,
    unit_type       TEXT NOT NULL,                  -- session, meal, hour, night, item
    quantity        NUMERIC(8,2) NOT NULL DEFAULT 1,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `case_notes`
```sql
CREATE TABLE case_notes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    enrollment_id   UUID NOT NULL REFERENCES enrollments(id),
    author_id       UUID NOT NULL REFERENCES users(id),
    note_text       TEXT NOT NULL,
    note_type       TEXT DEFAULT 'general',         -- general, risk, referral, milestone
    is_sensitive    BOOLEAN NOT NULL DEFAULT false,  -- restricted to supervisors
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at       TIMESTAMPTZ                      -- set 24h after create; prevents edits
);
-- Notes are append-only after locked_at; no UPDATE/DELETE via API
```

---

### 3.7 Volunteer tables

#### `volunteer_profiles`
```sql
CREATE TABLE volunteer_profiles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    skills          TEXT[] NOT NULL DEFAULT '{}',
    availability    JSONB NOT NULL DEFAULT '{}',    -- {mon: ["morning","afternoon"], ...}
    dbs_check_date  DATE,
    dbs_expiry_date DATE,
    dbs_reference   TEXT,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    onboarding_status TEXT NOT NULL DEFAULT 'pending',
    onboarding_checklist JSONB NOT NULL DEFAULT '{}',
    total_hours     NUMERIC(8,2) NOT NULL DEFAULT 0, -- materialised from hour_logs
    custom_fields   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, constituent_id)
);
```

#### `volunteer_opportunities`
```sql
CREATE TABLE volunteer_opportunities (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    program_id      UUID REFERENCES programs(id),
    title           TEXT NOT NULL,
    description     TEXT,
    required_skills TEXT[] NOT NULL DEFAULT '{}',
    min_age         SMALLINT,
    requires_dbs    BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `shifts`
```sql
CREATE TABLE shifts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    opportunity_id  UUID NOT NULL REFERENCES volunteer_opportunities(id),
    start_at        TIMESTAMPTZ NOT NULL,
    end_at          TIMESTAMPTZ NOT NULL,
    location        TEXT,
    capacity        SMALLINT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `shift_assignments`
```sql
CREATE TABLE shift_assignments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    shift_id        UUID NOT NULL REFERENCES shifts(id),
    volunteer_id    UUID NOT NULL REFERENCES volunteer_profiles(id),
    status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','waitlist','cancelled','no_show')),
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shift_id, volunteer_id)
);
```

#### `volunteer_hour_logs`
```sql
CREATE TABLE volunteer_hour_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    assignment_id   UUID REFERENCES shift_assignments(id),
    volunteer_id    UUID NOT NULL REFERENCES volunteer_profiles(id),
    program_id      UUID REFERENCES programs(id),
    log_date        DATE NOT NULL,
    hours           NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
    approved_by     UUID REFERENCES users(id),
    approved_at     TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.8 Impact tables

#### `impact_indicators`
```sql
CREATE TABLE impact_indicators (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    program_id      UUID REFERENCES programs(id),
    name            TEXT NOT NULL,
    description     TEXT,
    unit            TEXT NOT NULL,                  -- people, sessions, £, %, score
    target_value    NUMERIC(14,2),
    target_period   TEXT,                           -- annual, quarterly
    frequency       TEXT NOT NULL DEFAULT 'monthly',-- monthly, quarterly, annual
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `impact_readings`
```sql
CREATE TABLE impact_readings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    indicator_id    UUID NOT NULL REFERENCES impact_indicators(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    actual_value    NUMERIC(14,2) NOT NULL,
    notes           TEXT,
    recorded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.9 Communications tables

#### `receipts`
```sql
CREATE TABLE receipts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    donation_id     UUID REFERENCES donations(id),
    receipt_number  TEXT NOT NULL,                  -- human-readable sequential
    receipt_date    DATE NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,
    currency        CHAR(3) NOT NULL,
    country_format  CHAR(2) NOT NULL,               -- receipt legal format by country
    pdf_s3_key      TEXT,
    emailed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, receipt_number)
);
```

#### `email_sends`
```sql
CREATE TABLE email_sends (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    constituent_id  UUID NOT NULL REFERENCES constituents(id),
    campaign_id     UUID REFERENCES campaigns(id),
    template_id     TEXT,
    subject         TEXT NOT NULL,
    provider_msg_id TEXT,                           -- Resend/Brevo message ID
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced','opened','clicked','unsubscribed','failed')),
    opened_at       TIMESTAMPTZ,
    clicked_at      TIMESTAMPTZ,
    bounced_at      TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.10 Finance tables

#### `gl_batches`
```sql
CREATE TABLE gl_batches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL REFERENCES orgs(id),
    name            TEXT NOT NULL,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','posted')),
    posted_at       TIMESTAMPTZ,
    posted_by       UUID REFERENCES users(id),
    export_s3_key   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `gl_export_lines`
```sql
CREATE TABLE gl_export_lines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    org_id          UUID NOT NULL,
    batch_id        UUID NOT NULL REFERENCES gl_batches(id),
    donation_id     UUID REFERENCES donations(id),
    fund_id         UUID NOT NULL REFERENCES funds(id),
    nominal_code    TEXT NOT NULL,
    description     TEXT,
    debit           NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit          NUMERIC(14,2) NOT NULL DEFAULT 0,
    transaction_date DATE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Row-level security policies

### 4.1 PostgreSQL 3-Role Pattern

Givernance uses a **3-role pattern** for database access:

| Role | Attributes | Used by | RLS behavior |
|------|-----------|---------|-------------|
| `givernance` | Owner, `BYPASSRLS` | Migrations, relay, workers | Bypasses RLS (needs cross-tenant access) |
| `givernance_app` | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` | API server | **Subject to all RLS policies** |
| `postgres` | Superuser | Infrastructure only | Never used by application code |

The API server connects via `DATABASE_URL_APP` (the `givernance_app` role). Workers and the relay connect via `DATABASE_URL` (the `givernance` owner role) because they process jobs across tenants.

### 4.2 FORCE ROW LEVEL SECURITY

All tenant-scoped tables have both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. The `FORCE` keyword ensures that RLS policies apply even to the table owner — an extra safety net in case application code accidentally uses the wrong connection.

```sql
-- Migration 0004: Enable RLS + create policies
ALTER TABLE constituents ENABLE ROW LEVEL SECURITY;

-- Migration 0012: FORCE RLS on all tenant tables
ALTER TABLE constituents FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE donations FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
-- ... (all 14 tenant-scoped tables)
```

### 4.3 Tenant context per transaction

The API sets the tenant context inside a Drizzle transaction using `withTenantContext()`:

```sql
-- Executed by withTenantContext(orgId, callback) in packages/api/src/lib/db.ts:
BEGIN;
SELECT set_config('app.current_org_id', '018e1234-...', true);  -- true = transaction-scoped
-- All queries within this transaction are filtered by RLS policies
COMMIT;
```

> **Why `set_config(..., true)` instead of `SET LOCAL`?** Both are transaction-scoped. `set_config` returns a value and integrates cleanly with Drizzle's `sql` template tag. The `true` parameter ensures the setting is discarded at transaction end — safe with connection pooling.

### 4.4 Representative policies

```sql
-- Policy: users can only see their own org's data
CREATE POLICY constituent_org_isolation ON constituents
    USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- Policy: erased constituents visible only to gdpr_admin role
CREATE POLICY constituent_erasure_visibility ON constituents
    USING (
        erased_at IS NULL
        OR current_setting('app.current_role') IN ('org_admin', 'gdpr_admin')
    );
```

---

## 5. RBAC roles

| Role | Description | Key permissions |
|---|---|---|
| `super_admin` | Givernance operations team | All orgs, all data |
| `org_admin` | NPO system administrator | All data within org, user management, billing |
| `fundraising_manager` | Manages donors, campaigns, donations | Constituents (rw), donations (rw), campaigns (rw), grants (r), reports (r) |
| `program_manager` | Manages service delivery | Programs (rw), enrollments (rw), beneficiaries (rw), volunteers (r) |
| `volunteer_coordinator` | Manages volunteers | Volunteer profiles (rw), shifts (rw), hour logs (rw), constituents (r) |
| `data_entry` | Enters operational data | Constituents (rw), donations (rw), service deliveries (rw) |
| `finance_viewer` | Read-only finance access | Donations (r), funds (r), GL exports (r), reports (r) |
| `volunteer` | Self-service volunteer portal | Own profile (rw), own shifts (r), own hour logs (rw) |
| `beneficiary` | Self-service beneficiary portal | Own record (r), own case notes (r, non-sensitive) |
| `report_only` | External auditor / funder | Defined report set (r) |

---

## 6. GDPR erasure strategy

When a subject erasure request is approved:

```
1. SET constituents.erased_at = now(),
       first_name = '[ERASED]', last_name = '[ERASED]',
       email_primary = NULL, phone_primary = NULL,
       addr_line1 = NULL, addr_city = NULL, addr_postcode = NULL
2. DELETE gdpr_consent_log WHERE constituent_id = ...
3. Nullify case_notes.note_text WHERE enrollment.constituent_id = ... (sensitive)
4. Set email_sends anonymised (keep count, remove email address)
5. RETAIN: donation records (financial obligation), volunteer_hour_logs (VAT / audit)
6. INSERT audit_log record of erasure execution
7. Publish constituent.gdpr_erased domain event
```

Financial records (donations, GL lines) are RETAINED with the constituent ID pointing to the anonymised stub. This satisfies both GDPR erasure and financial record-keeping obligations.

---

## 7. Indexing strategy

| Pattern | Index type | Tables |
|---|---|---|
| Tenant + primary key lookups | BTree (org_id, id) | All |
| Full-text constituent search | GIN trigram (pg_trgm) | `constituents` |
| Date range queries | BTree on date columns | `donations`, `service_deliveries`, `shifts` |
| Tag filtering | GIN on array | `constituents.tags` |
| Custom field queries | GIN on JSONB | `constituents`, `donations` |
| Soft-delete exclusion | Partial index `WHERE deleted_at IS NULL` | `constituents`, `donations` |
| Event outbox poll | Partial index `WHERE status = 'pending'` | `outbox_events` |
