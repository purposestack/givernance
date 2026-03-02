# 10 — Open Questions

## Technical / Architecture

1. Which NPSP objects are mandatory in v1 mapping vs v2?
2. Single-tenant option at launch or post-PMF only?
3. Scope of built-in email automation vs external ESP integration?
4. Accounting integrations priority (Xero, Sage, Exact, others)?
5. Which NGO vertical template ships first in production?
6. Data residency variants (EU only vs country-specific) needed in year 1?
7. What SLA tiers are realistically supportable in first 12 months?

---

## Strategic / Product Vision

### 8. Givernance as an organizational platform — not just a CRM

**Question raised**: Should Givernance go beyond CRM and become the central organizational hub of an NPO — integrating communication, collaboration, and AI participation?

**Context**: NPO staff spend time split between their CRM (data) and communication tools (Slack, WhatsApp, email). This fragmentation creates friction and breaks context. A platform that unifies data + communication could be a significant differentiator and "future-proof" the product.

**Options analyzed**:

| Approach | Effort | Differentiating? | Recommendation |
|---|---|---|---|
| Build full Slack/Discord replacement | Very high — competes with Slack | Not really, and we'd lose | ❌ Reject |
| Threaded activity feed on every record | Medium — build once, high value | Yes — contextual collaboration | ✅ v1.1 target |
| @mention and notifications within platform | Low-medium | Yes — connects staff to records | ✅ v1 consideration |
| AI as a mentionable team participant | Medium — AI infra already exists | **Highly differentiating** | ✅ v2 target |
| Video call button (Whereby/Jitsi embed) | Low — integration only | Nice to have | ✅ Simple integration |
| Organization activity feed (news feed) | Medium | Differentiating | ✅ v1.1 target |

**Recommended direction**:

#### v1: Foundation
- **Record-level activity feed**: every mutation on a constituent, grant, or case creates a feed entry visible to the team
- **Threaded comments on records**: staff can comment inline on any record, with @mention support
- **In-app notifications**: consolidate all notifications (AI suggestions, deadlines, @mentions) in one inbox

#### v1.1: Collaboration layer
- **Organization activity feed** (homepage): real-time feed of what's happening across the org — donations received, cases updated, grants awarded, volunteers confirmed
- **Video meeting button**: embed Whereby/Jitsi on any record for ad-hoc calls with a funder, a beneficiary, a volunteer
- **Shared workspaces per grant/program**: a focused view combining data + discussion + documents for a specific project

#### v2: AI as a team member
- **@Givernance in any thread**: tag the AI in any conversation to ask questions, get context, trigger actions
  - Example: "@Givernance quelle est la situation de Marie Dupont ?" → AI summarizes donor history, last interactions, pending tasks
  - Example: "@Givernance rédige un brouillon de relance pour cette subvention" → AI drafts a grant renewal message
- **AI-generated activity summaries**: each Monday, AI posts a brief in the org feed summarizing the week's key movements
- **Proactive AI interventions**: AI posts in the feed when it detects something requiring attention ("La subvention FSE+ arrive à échéance dans 14 jours — aucun rapport en cours.")

**Impact on design**:
- The homepage dashboard evolves from a static metrics page to a **living organizational feed** (think: Linear + Notion + Slack channel, but organized around NPO data)
- Records gain a persistent "discussion" panel alongside the activity timeline
- Navigation may need a dedicated "Communication" or "Fil d'activité" section

**Decision needed**: Confirm scope for v1 vs v1.1 before implementation starts.

**Mise à jour 2026-02** : cette vision est désormais explorée plus en profondeur dans le **mode conversationnel** — 11 mockups HTML explorant un agent IA en langage naturel avec orchestration d'actions, résultats inline, et vue hybride. Voir [docs/vision/conversational-mode.md](./vision/conversational-mode.md) et les mockups dans `docs/design/conversational-mode/`.

---

### 9. AI mode defaults by organization size

**Question**: Should the default AI mode (Manual / Assisted / Autopilot) differ based on organization size or type?

**Hypothesis**: A 5-person charity with no IT staff might want more automation (Autopilot default) while a 50-person NGO with dedicated data staff may prefer Manual or Assisted.

**Decision needed**: Define default mode assignment logic in onboarding wizard.

---

### 10. White-label and partner channel

**Question**: Is white-labeling a v1 or v2 feature? Who are the likely white-label partners?

**Context**: Nonprofit technology consultants migrating clients off Salesforce are a key distribution channel. A white-label offering (custom domain, custom logo, custom primary color) could accelerate partner adoption.

**Decision needed**: Define minimum white-label feature set and pricing tier for partners.
