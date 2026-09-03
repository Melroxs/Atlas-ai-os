# ATLAS — INTEGRATION GAP ANALYSIS

> **Purpose.** Determine which external systems are required for true job
> completion by the six workers, and the honest current state of each. **No
> integration is claimed to exist unless the repository proves it.**
>
> Current-state ground truth (from the capability audit):
> - Implemented connectors: **manual upload**, **Google Drive** (OAuth, change
>   detection, dedupe, sync via `connections-run-due-syncs` + Drive OAuth flow).
> - Catalog-only ("planned", no client): Gmail, Microsoft 365, Slack, HubSpot,
>   QuickBooks, Stripe-as-connector, Dropbox, Notion, GitHub
>   (`src/lib/atlas-data/connectors-registry.ts`).
> - Edge functions deployed/implemented: `conversation-converse` (AI),
>   `connections-run-due-syncs` (Drive sync), `email` (IMAP/SMTP mailboxes),
>   `outreach-send` (Resend CRM outreach), `stripe-checkout/portal/webhook`
>   (billing), `team-invite-email`, `admin-provision-user`.

Priority legend: **P0** = required for safety/correctness · **P1** = required for a
worker to finish meaningful work · **P2** = automation · **P3** = end-to-end
execution enabler · **P4** = optimization.

| Integration | Why needed | Current state | API available? | Auth requirement | Data exchanged | Human approval required? | Priority |
|---|---|---|---|---|---|---|---|
| **Xactimate (or compatible estimating platform)** | Estimator + Supplement Specialist cannot produce submittable estimates or line-item supplements without the industry pricing/estimating standard | **NONE** — estimator output is explicitly "review-ready data for input into Xactimate" (`estimator.ts` disclaimer + UI); no client, no API wiring, no credentials | Yes (vendor API; licensing required) | Vendor account + API credentials (server-side) | Estimate line items, quantities, prices, scope | Yes — licensed estimator review before any push; a future write path must require approved governance decision | P1 (job completion) |
| **Insurance carrier portals** | Supplement submission + claim status + coverage info is where the job actually completes | **NONE** — supplements stop at PREPARED/AWAITING_EXTERNAL_EXECUTION; human submits manually | Varies by carrier (portals often web-only, no public API) | Per-carrier accounts | Supplements, responses, status | Yes — submission REVIEW_REQUIRED + approval persisted before execution | P1 |
| **Email (worker outbound: carrier/adjuster/customer)** | Every worker's external actions require sending correspondence; currently drafts stop at "drafted" | **NONE for workers.** `draftCommunication` produces drafts only (`status:"drafted"`, `requiresApproval:true`). Real send paths exist elsewhere: `outreach-send` (Resend, pilot CRM, super_admin/atlas_admin) and `email` (IMAP/SMTP user mailboxes) | Yes | Resend key / mailbox credentials; both exist but are **not wired to worker communications** | Approved drafts → sent messages → delivery records | Yes — communication_sending REVIEW_REQUIRED; integration must check persisted decision state before send (bypass tests documented) | P1 |
| **SMS** | Customer appointment reminders, urgent updates | **NONE** — no SMS anywhere | Yes (Twilio-class) | Server-side key | Reminders, updates | Yes — same comm approval flow | P2 |
| **CRM (customer/lead master)** | Customer Success needs real customer records (currently a claim text field); sales uses pilot CRM | **PARTIAL** — pilot CRM (leads, CSV import, outreach, templates) exists and is live; **not a customer master for claims** | Yes | Existing app auth | Customer profiles, contact history, leads | No (CRM data entry) | P2 |
| **Accounting / QuickBooks** | Revenue Recovery must match expected vs received against the real ledger; invoicing lives there | **NONE** — QuickBooks is a catalog entry ("planned"); no client | Yes (Intuit OAuth2) | OAuth (server-side) | Invoices, payments, journal entries | Yes for posting; review for writes | P1 |
| **Bank/ACH feeds** | Payment reconciliation | **NONE** | Depends on bank | OAuth/keys | Payments, deposits | Yes | P3 |
| **Document storage (beyond Drive + Supabase Storage)** | Evidence retention, retention policies, carrier document requirements | **PARTIAL** — Supabase Storage buckets + Google Drive implemented; retention enforcement MISSING | Yes | Existing | Evidence docs | No | P2 |
| **Calendars (Google/Microsoft)** | Project Manager scheduling + Customer Success appointments | **NONE** — no calendar integration | Yes (OAuth) | OAuth | Project milestones, appointments | Yes for customer-facing bookings | P2 |
| **Project management tools (e.g., ClickUp/Asana/Monday)** | PM work lives in the company's tooling | **NONE** — no PM integration; no PM feature in Atlas | Yes | OAuth | Projects, tasks, milestones | No | P3 |
| **Communication systems (Slack/Teams)** | Internal notifications + human-in-the-loop routing | **NONE** — Slack/Microsoft 365 are catalog entries; `notifications` table exists but no channel delivery | Yes | OAuth | Work items, governance decisions, alerts | No | P3 |
| **Weather data** | Storm-claim validation, loss-date corroboration for supplements | **NONE** | Yes (e.g., NOAA/weather APIs) | Key | Storm events, hail/wind data by date+location | No (informational) | P2 |
| **Mapping / property data** | Property characteristics for estimating, flood/hazard context | **NONE** | Yes (GIS/property APIs) | Key | Parcel data, property attributes | No | P3 |
| **Estimating/pricing data (separate from Xactimate)** | Pricing source for line items without Xactimate | **NONE** — no pricing data; prices default to 0 → human | Yes (licensed feeds) | License + key | Price tables by line code/region | Yes (rates) | P1 |
| **Insurer data (coverage APIs)** | Coverage context for claims (currently not modeled) | **NONE** | Limited | Per-carrier | Policy terms, coverage | Yes | P3 |
| **Telephony (voice calls)** | Customer contact | **NONE** — voice is STT/TTS in-app only | Yes | Key | Call logs | Yes | P4 |

## Cross-cutting requirements for every future integration

1. **Governance-before-execution**: an external write (send, submit, post, push)
   must read the persisted governance decision and refuse when
   `execution_status != approved/ALLOW-executed` (bypass patterns H/I in
   `governance-live.e2e.test.ts`).
2. **Preparation ≠ submission**: Atlas may prepare; only an approved human decision
   may execute; the UI must never imply Atlas submitted anything.
3. **Credentials server-side only**: keys live in edge-function secrets
   (Supabase `supabase secrets set`), never the browser bundle (established pattern:
   `GEMINI_API_KEY`, `RESEND_API_KEY`, `ENCRYPTION_KEY`).
4. **Idempotency + audit**: every external action needs a persisted action record
   (`toolActions` table exists; edge functions must log `log_audit` events — the
   RPC pattern already does).
5. **Tenant isolation**: integration credentials and sync data stay per-tenant
   (`connections`/`connectionTokens` tables are tenant-scoped, service-role-only
   for tokens).

## Honest statement

The **only** real external integrations today are: Google Drive (documents in),
Resend (pilot sales outreach), IMAP/SMTP mail (user mailboxes), and Stripe
(billing). **None of the six workers can complete a job through an external system
today** — every worker's external step is explicitly human-executed, and that
boundary must be preserved until the integrations above exist and are
governance-gated.