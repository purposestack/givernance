# 01 — Product Scope

> **Givernance NPO Platform** — Pragmatic nonprofit operations software for European organizations.
> Last updated: 2026-02-24

---

## 1. Problem statement

European nonprofits running on Salesforce NPSP face a compounding set of problems:

| Problem | Impact |
|---|---|
| Salesforce licensing jumps to €75+/seat once the 10 free seats are consumed | Most operational NPOs need 15–40 users; cost becomes prohibitive |
| GDPR compliance is retrofitted, not native | Right-to-erasure, audit logs, data residency, consent management are painful to implement |
| NPSP complexity requires dedicated Salesforce admins | Small NPOs cannot afford this; they either under-use the platform or accumulate technical debt |
| US-centric data model (USD, US salutations, US tax receipts) | EU orgs spend weeks customizing for EUR, GDPR, EU charity law |
| No integrated case management or impact measurement | NPOs running programs must bolt on additional tools |
| Vendor lock-in with proprietary APIs and data formats | Exporting your own data is difficult and often incomplete |

**Givernance** replaces Salesforce NPSP for small to medium European nonprofits (2–200 staff). It is purpose-built for:
- Constituent relationship management
- Fundraising (donations, pledges, campaigns)
- Grant lifecycle management
- Program delivery and beneficiary management
- Volunteer coordination
- Impact measurement and reporting
- GDPR-native compliance tooling
- Finance handoff (not a full accounting system)

---

## 2. Vision statement

> **"Every nonprofit should have enterprise-grade constituent and program management, without needing a Salesforce admin — and without navigating 16 modules for a simple question."**

Givernance est conçu comme un **dual-mode platform** :
- **GUI IA-augmenté** : interface structurée classique (modules, formulaires, tableaux) enrichie par trois niveaux de collaboration IA (Manuel, Assisté, Autopilote — cf. [docs/13-ai-modes.md](./13-ai-modes.md)).
- **Mode conversationnel** (vision 2026-2028) : agent IA en langage naturel, capable d'orchestrer des actions multi-étapes, d'afficher des résultats inline, et de réduire 80 % des interactions quotidiennes à une conversation — cf. [docs/vision/conversational-mode.md](./vision/conversational-mode.md).

Les deux paradigmes coexistent et partagent le même back-end, les mêmes garde-fous RGPD, et le même système de permissions.

## 3. AI-native UX principle (cross-feature)

Givernance should use AI agents **inside each core workflow** to reduce clicks, reduce admin burden, and improve data quality — without hiding critical decisions.

Design rules:
- AI proposes, human confirms for sensitive operations (finance, compliance, beneficiary status)
- Explainability required: each suggestion includes "why" + source fields
- Trust boundaries: no irreversible action without confirmation
- Full auditability of AI actions/prompts/outputs
- Progressive disclosure: simple UX for non-technical NPO teams

Research requirement:
For each major feature, run a lightweight UX research loop:
1) identify top friction tasks
2) map where an AI assistant can remove complexity
3) prototype AI-assisted interaction
4) measure time saved + error reduction + confidence



> **"Every nonprofit should have enterprise-grade constituent and program management, without needing a Salesforce admin."**

Givernance is not trying to be Salesforce. It is trying to be the tool that 80% of nonprofits actually need: fast to set up, genuinely affordable, GDPR-compliant by default, and deployable in a week — not six months.

---

## 3. Target customers

### Primary: Small-to-medium European NPOs

| Characteristic | Range |
|---|---|
| Annual operating budget | €50K – €5M |
| Staff count | 3 – 150 FTE + volunteers |
| Active constituents (donors + beneficiaries) | 500 – 100,000 |
| Countries | EU 27, UK, Switzerland, Norway |
| Org types | Charities, associations, foundations, social enterprises |

### Secondary: Consultants and implementation partners
- Nonprofit technology consultants migrating clients off Salesforce
- Managed service providers hosting NPO software

### Out of scope (v1)
- Large federated nonprofits (>500 staff) with complex data hierarchies
- US-based organizations (different tax receipt law, different payment rails)
- Pure advocacy / political organizations (different data model)
- Universities and hospitals (too specialized)

---

## 4. Must-have functional areas (NPSP parity + EU-native)

These are the non-negotiable capabilities for v1. Any platform missing these cannot replace Salesforce NPSP for a functioning NPO.

### 4.1 Constituent management
**What**: Unified record of every person and organization the NPO interacts with — donors, beneficiaries, volunteers, staff, partner orgs, board members.

| Feature | Priority | Acceptance check |
|---|---|---|
| Individual constituent record (name, contact info, salutation, preferred comms) | MUST | Can create, search, view, edit a person |
| Household grouping (family unit for receipt aggregation) | MUST | Multiple constituents linked to one household; household-level gift summary |
| Organization record (company, foundation, government body) | MUST | Org record with primary contact and relationship to individuals |
| Relationship tracking (spouse, sibling, board member of, employed by) | MUST | Typed bidirectional relationships; visible on both record sides |
| Duplicate detection on create/import | MUST | Exact + fuzzy match on name+email; flag or merge |
| Custom fields per constituent type | MUST | Org admin can add custom fields via UI; stored in JSONB |
| Communication preferences and suppression | MUST | Can mark "do not email", "do not mail", "do not contact"; suppression respected in bulk sends |
| GDPR consent log per constituent | MUST | Consent records: basis, date, scope, channel; full history |
| Contact timeline (all activity, donations, notes) | MUST | Chronological feed on constituent record |
| Constituent tagging and segmentation | SHOULD | Freeform tags + segment queries |

### 4.2 Donations and pledges
**What**: Every financial gift from a constituent, whether one-time, recurring (pledge), in-kind, or matched.

| Feature | Priority | Acceptance check |
|---|---|---|
| One-time donation record (amount, date, campaign, fund, payment method) | MUST | Can record a gift; appears in donor history and campaign totals |
| Recurring donation / pledge (schedule, installments, status) | MUST | Monthly pledge creates scheduled installments; each installment links to payment |
| Pledge balance tracking | MUST | Outstanding balance = pledge total − paid installments |
| In-kind gift (non-cash, with estimated value) | MUST | Can record in-kind with type and valuation; excluded from cash totals |
| Matching gift tracking (employer match request, confirmation) | SHOULD | Match linked to original donation; shows as separate gift from employer org |
| SEPA direct debit (EU standard recurring payment) | MUST | Integration with Stripe/Mollie SEPA; mandate reference on record |
| Gift acknowledgement / receipt (EU tax receipt format) | MUST | Auto-generates PDF receipt with charity registration number, GDPR notice |
| Fund allocation (split gift across restricted funds) | MUST | One donation split to multiple funds with amounts |
| Soft credit (gift credited to a third party, e.g. solicitor) | SHOULD | Soft credit record linked to original donation |
| Anonymous donation handling | MUST | Can mark anonymous; donor name not shown in reports/exports |
| Donor lifecycle stage (prospect, first-time, repeat, lapsed, major donor) | MUST | Auto-calculated based on giving history |
| LYBUNT / SYBUNT reports | MUST | "Gave Last Year But Unfortunately Not This" standard report |

### 4.3 Campaigns
**What**: Coordinated fundraising drives with goals, channels, and response tracking.

| Feature | Priority | Acceptance check |
|---|---|---|
| Campaign record (name, start/end date, goal, type) | MUST | Can create campaign; donations linked to it |
| Campaign hierarchy (parent/child campaigns) | SHOULD | Annual giving campaign → sub-campaigns by channel |
| Source code tracking on donations | MUST | Donation carries campaign source code; used in ROI calc |
| Campaign KPIs (raised, donors, average gift, response rate) | MUST | Auto-calculated from linked donations |
| Multi-channel campaign (email, post, event, digital) | SHOULD | Channel field on campaign; breakdown in reports |
| Campaign calendar view | NICE | Calendar showing active/planned campaigns |

### 4.4 Grant management
**What**: Full lifecycle of foundation and government grants — application, reporting, receipt, compliance.

| Feature | Priority | Acceptance check |
|---|---|---|
| Grant record (funder, amount, purpose, restrictions) | MUST | Grant linked to funder org; amount tracked in relevant fund |
| Application pipeline (prospecting, applied, awarded, rejected, reporting) | MUST | Status workflow with dates; pipeline view |
| Grant reporting deadlines and reminders | MUST | Automated reminder 30/14/7 days before report due |
| Multi-year grants (tranches per year) | MUST | Multi-year grant record with annual installments |
| Restricted fund tracking (grant funds ring-fenced) | MUST | Grant linked to restricted fund; spend tracked against grant |
| Grant contact relationships (program officer, funder contacts) | SHOULD | Contacts at funder org linked to grant record |
| Deliverable tracking (grant deliverables with completion status) | SHOULD | Checklist of commitments with due dates and owners |

### 4.5 Programs and service delivery
**What**: The services the NPO delivers — what programs exist, who receives them, what was delivered.

| Feature | Priority | Acceptance check |
|---|---|---|
| Program catalog (name, description, type, funder, status) | MUST | Programs listed; each linked to relevant grants/funds |
| Beneficiary enrollment (constituent enrolled in program) | MUST | Enrollment record: start date, status, program |
| Service unit recording (session, meal, hour, night of shelter) | MUST | Service delivery record against enrollment; aggregated in reporting |
| Case notes (narrative progress notes, linked to beneficiary) | MUST | Timestamped narrative notes; author recorded; not editable after 24h |
| Case closure and outcome recording | MUST | Case closed with outcome type (completed, referred, disengaged) |
| Caseload management (worker × beneficiaries) | SHOULD | Can see all active cases assigned to a worker |
| Referral tracking (referred in from / out to other orgs) | SHOULD | Referral record with external org and date |
| Waitlist management | NICE | Beneficiaries on waitlist with join date; auto-notify on vacancy |

### 4.6 Volunteer management
**What**: Recruitment, scheduling, hour logging, and recognition for volunteers.

| Feature | Priority | Acceptance check |
|---|---|---|
| Volunteer profile (skills, availability, DBS check status, emergency contact) | MUST | Volunteer record extending constituent; skills list |
| Opportunity/role catalog (what volunteer roles exist) | MUST | Volunteer opportunity with time commitment and requirements |
| Shift scheduling and assignment | MUST | Calendar view of shifts; volunteers assigned; confirmation sent |
| Hour logging (actual hours worked per shift) | MUST | Hours recorded; volunteer total shown on profile |
| Hour valuation report (volunteer hours × standard rate) | MUST | Total volunteer value for annual report / grant reports |
| DBS / background check expiry tracking | MUST | Alert when check expires; block assignment if expired |
| Volunteer onboarding workflow | SHOULD | Checklist: application, interview, reference check, DBS, induction |
| Volunteer self-service portal (view shifts, log hours) | SHOULD | Authenticated volunteer login; limited view |

### 4.7 Impact measurement and KPIs
**What**: Capturing and reporting outcomes — going beyond outputs to demonstrate real impact.

| Feature | Priority | Acceptance check |
|---|---|---|
| Impact indicator catalog (custom KPI definitions) | MUST | Org can define indicators: name, unit, target, frequency |
| Impact reading recording (actual values against indicators) | MUST | Data entry against indicator; linked to program or period |
| Theory of change builder (inputs → activities → outputs → outcomes) | SHOULD | Visual ToC map; indicators linked to outcomes |
| Funder-specific reporting templates | SHOULD | Report template per funder mapping platform data to their required fields |
| Impact dashboard (visual summary of key KPIs) | MUST | Configurable dashboard; exportable as PDF |
| SROI calculation helper (Social Return on Investment) | NICE | Guided SROI calc with standard values |

### 4.8 Finance handoff
**What**: Getting donation and fund data into the accounting system. Givernance is NOT an accounting system.

| Feature | Priority | Acceptance check |
|---|---|---|
| General Ledger export (journal entries by fund, period) | MUST | Export CSV/JSON of summarized transactions by nominal code and period |
| Chart of accounts mapping (Givernance funds → accounting nominal codes) | MUST | Org admin maps each fund to a nominal code |
| Donation batch closing (confirm a batch of gifts for posting to GL) | MUST | Batch marked "posted"; prevents re-export |
| Gift aid / tax reclaim data export (UK: HMRC format; FR: reçu fiscal) | MUST | Country-specific tax reclaim export formats |
| Restricted fund balance report | MUST | Fund balance = received − spent; exportable to accountant |
| Direct Xero / QuickBooks integration | SHOULD | API push of journal entries; reconciliation report |

### 4.9 Communications
**What**: Acknowledgements, receipts, newsletters, bulk mail — inbound and outbound.

| Feature | Priority | Acceptance check |
|---|---|---|
| Donation acknowledgement letter (auto or manual) | MUST | Triggered on donation create; templated letter with merge fields |
| Tax receipt PDF (EU country-specific formats) | MUST | Auto-generated; emailed and stored; retrievable from donor record |
| Bulk email (segmented send to constituents) | MUST | Build segment, compose email, send; open/click tracking |
| Email unsubscribe / suppression management | MUST | One-click unsubscribe; suppression list enforced on all sends |
| SMS notification (basic — receipt, shift reminder) | SHOULD | Optional; via Twilio or equivalent |
| Postal address export for mail house | SHOULD | Filtered export with address deduplication |
| Communication history on constituent record | MUST | Every sent email/letter recorded; shown in timeline |

---

## 5. Explicit out-of-scope for v1

| Capability | Why excluded | Future path |
|---|---|---|
| Full accounting / double-entry bookkeeping | Replaces accounting software; out of lane | GL export → external accounting |
| Event management (ticketing, check-in) | Standalone market; integration preferred | Eventbrite API integration |
| Peer-to-peer fundraising pages | Complex; separate product | Stripe-hosted donation forms as stopgap |
| Legacy postal mail fulfilment | Physical logistics out of scope | Export → mail house |
| Staff HR / payroll | Not nonprofit-specific | Integration with HR system |
| Board governance / meeting management | Different buyer | Integration with Boardable/BoardEffect |
| US tax receipts (990, gift aid reclaim US) | Out of initial geography | v2 US market expansion |
| Real-time telephony / call centre | Specialist tooling | Integrate with existing call centre |

---

## 6. Success metrics (product-level)

| Metric | Target (18 months post-launch) |
|---|---|
| Paying organizations | 150+ |
| Organizations successfully migrated from Salesforce | 30+ |
| Average setup time (from signup to live operations) | < 5 days |
| NPS (Net Promoter Score) | > 45 |
| Churn rate | < 8% annually |
| Support ticket volume per org per month | < 2 (measure of usability) |
| GDPR data subject requests fulfilled in time | 100% within 30 days |

---

## 7. Definition of MVP

MVP is achieved when a single NPO can:
1. Import their constituent list (CSV or from Salesforce)
2. Record a donation and generate a GDPR-compliant receipt
3. Run a campaign and see how much it raised
4. Enroll a beneficiary in a program and record a service delivery
5. Export gift aid / tax reclaim data
6. Run a donor retention (LYBUNT) report
7. Comply with a GDPR subject access request for a constituent

Everything else is Phase 2 or Phase 3.
