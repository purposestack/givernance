## ADR-009 — Scaleway as Primary SaaS Managed Cloud Provider

**Status**: Accepted
**Date**: 2026-03-30
**Deciders**: Magino (founder/architect)
**Supersedes**: ADR-006 (removed)

### Context

ADR-006 previously selected a multi-vendor cloud setup. This decision supersedes that by consolidating all managed infrastructure under a single European cloud provider.

The beneficiary data processing requirement (GDPR Art. 9 special category data) requires that AI inference for case notes and medical/social status run on EU infrastructure with no data leaving EU jurisdiction. The original plan specified self-hosted Ollama on a VPS — adding operational burden and GPU procurement complexity.

A holistic evaluation was conducted to identify a single European cloud provider covering compute, managed databases, cache, storage, observability, and AI inference in an `integrated platform under a single GDPR-native contract`.

### Options evaluated (Summary)

Scaleway was compared against UpCloud, OVH Cloud, and Railway across criteria like headquarters, regions, managed services (PostgreSQL, Redis, Object Storage), integrated observability, managed AI inference in EU, GDPR/DPA, pricing transparency, and Keycloak support. Scaleway emerged as the most comprehensive solution.

### Decision

**Scaleway** is selected as the primary cloud provider for the Givernance SaaS managed offering, replacing the tri-vendor setup (Neon.tech + Upstash + Cloudflare R2) from the superseded ADR-006.

### Rationale

1.  **Cockpit (Grafana + Loki + Mimir + Tempo)**: Unified observability platform included natively. Scaleway-native metrics and logs are free; custom log ingestion billed at volume. Eliminates the need to self-host Grafana/Loki stacks or pay for a separate SaaS observability tool.
2.  **Managed Inference EU (Mistral, Llama 3.1)**: Scaleway's Generative APIs provide pay-per-token and dedicated GPU inference endpoints hosted exclusively in EU datacenters. This directly replaces the self-hosted Ollama requirement for beneficiary data (GDPR Art. 9) — no GPU procurement, no ML ops overhead, full GDPR coverage under the Scaleway DPA.
3.  **Single European cloud, single DPA**: All infrastructure (compute, database, cache, storage, inference, observability) operates under one GDPR-native contract from a French company. Eliminates the multi-vendor DPA management overhead.
4.  **Managed PostgreSQL, Redis, Object Storage**: Direct functional equivalents to previously considered providers. PostgreSQL supports all required extensions (uuid-ossp, pgcrypto, pg_trgm, ltree, pg_audit). Redis covers BullMQ job queue + rate limiting (though now pg-boss is the primary queue). Object Storage is S3-compatible.
5.  **Predictable fixed pricing**: Hourly billed VMs and managed services with published pricing. No cold-start latency, no per-request surprise billing.
6.  **Keycloak compatibility**: Scaleway VMs support self-hosted Keycloak in all configurations.

### Cost estimates (Summary)

Detailed cost estimates for Phase 0 (Dev/staging), Phase 1 (1 NPO pilot), and Phase 1 extended (5–10 NPOs) are provided, ranging from ~67€/month for dev/staging to ~458€/month for extended Phase 1. Optional AI inference costs (pay-per-token or dedicated GPU) are also detailed.

### Consequences

- ✅ **Replaces** Neon.tech → Scaleway Managed PostgreSQL EU
- ✅ **Replaces** Upstash Redis → Scaleway Managed Redis EU
- ✅ **Replaces** Cloudflare R2 → Scaleway Object Storage (S3-compatible API)
- ✅ **Replaces** self-hosted Ollama → Scaleway Generative APIs (Mistral, Llama 3.1) for beneficiary data AI
- ✅ **Adds** Scaleway Cockpit: Grafana, Loki, Mimir, Tempo for observability
- ✅ **Single vendor DPA** replaces three separate DPAs
- ✅ Keycloak remains **self-hosted on Scaleway VMs**
- ⚠️ NATS JetStream remains **Phase 4+** — the BullMQ (now pg-boss) outbox pipeline is primary for Phase 0-3
- ⚠️ Self-hosted Docker Compose deployment (NPO on-premises) is **unchanged**

### Revisit criteria (Summary)

Criteria for revisiting include pricing changes, unsupported PostgreSQL extensions, stricter data sovereignty requirements, unacceptable AI latency, future NATS JetStream needs, or GPU inference demand.

---

