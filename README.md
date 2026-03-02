# Givernance NPO Platform Blueprint

Deep architecture blueprint for a pragmatic nonprofit-focused alternative to Salesforce.

**Libero** is a purpose-built CRM for European nonprofits (2-200 staff), replacing Salesforce NPSP with GDPR-native compliance, affordable pricing, and an AI-augmented dual-mode interface.

## Design Mockups

86 interactive HTML mockups across 17 modules, viewable on GitHub Pages :

**[Voir les mockups](https://onigam.github.io/libero-npo-platform/design/)**

- **75 ecrans GUI classique** : Auth, Dashboard, Constituants, Dons, Campagnes, Subventions, Programmes, Benevoles, Impact, Communications, Finance, RGPD, Admin, Rapports, Migration, Global
- **11 ecrans Mode Conversationnel** (vision 2026-2028) : hub IA, orchestration d'actions, vue hybride, mobile, dashboard evolue — [voir les mockups conversationnels](https://onigam.github.io/libero-npo-platform/design/conversational-mode/index.html)

### Vision dual-mode

Libero propose deux paradigmes d'interaction complementaires :

1. **GUI IA-augmente** — Interface classique enrichie par des suggestions IA inline (3 modes : Manuel, Assiste, Autopilote)
2. **Mode conversationnel** (vision) — Agent IA en langage naturel, orchestration d'actions, composants invocables

Voir [docs/vision/conversational-mode.md](docs/vision/conversational-mode.md) pour l'architecture detaillee.

## Documentation

### Architecture & Specs
- [docs/01-product-scope.md](docs/01-product-scope.md)
- [docs/02-reference-architecture.md](docs/02-reference-architecture.md)
- [docs/03-data-model.md](docs/03-data-model.md)
- [docs/04-business-capabilities.md](docs/04-business-capabilities.md)
- [docs/05-integration-migration.md](docs/05-integration-migration.md)
- [docs/06-security-compliance.md](docs/06-security-compliance.md)
- [docs/07-delivery-roadmap.md](docs/07-delivery-roadmap.md)
- [docs/08-pricing-packaging.md](docs/08-pricing-packaging.md)
- [docs/09-risk-register.md](docs/09-risk-register.md)
- [docs/10-open-questions.md](docs/10-open-questions.md)

### Design & UX
- [docs/11-design-identity.md](docs/11-design-identity.md) — Identite visuelle, tokens, composants, accessibilite
- [docs/12-user-journeys.md](docs/12-user-journeys.md) — Parcours utilisateurs (5 personas)
- [docs/13-ai-modes.md](docs/13-ai-modes.md) — Trois modes d'interaction IA (Manuel, Assiste, Autopilote)
- [docs/14-screen-inventory.md](docs/14-screen-inventory.md) — Inventaire complet des 86 ecrans
- [docs/vision/conversational-mode.md](docs/vision/conversational-mode.md) — Vision mode conversationnel 2026-2028

## Diagrams
- diagrams/context.mmd
- diagrams/container.mmd
- diagrams/core-erd.mmd
- diagrams/migration-flow.mmd

## Specialized agents
- .claude/agents/domain-analyst.md
- .claude/agents/data-architect.md
- .claude/agents/platform-architect.md
- .claude/agents/migration-architect.md
- .claude/agents/security-architect.md
- .claude/agents/pricing-strategist.md
