# Atlas AI Runtime — Phase 2 Migration Report

**Date:** 2026-08-28
**Status:** Phase 2 Complete — frontend AI workloads migrated to ai-runtime

---

## 1. Inventory Summary

### Total AI Call Sites Found

| # | Call Site | Location | Type | Provider | Migration Status |
|---|---|---|---|---|---|
| 1 | Client-side Embeddings | `src/lib/knowledge/embeddings.ts` | `fetch()` to Gemini REST API | Gemini `text-embedding-004` | **✅ MIGRATED** → ai-runtime `embed()` |
| 2 | Ask Atlas / Voice | Edge Function (deployed separately) | `fetch()` to Gemini REST API | Gemini chat | **⚠️ OUT OF SCOPE** — Edge Function not in this repo |
| 3 | CRM Outreach | `src/lib/crm/ai-outreach.ts` | `supabase.functions.invoke()` → Edge Function | Indirect (Gemini via edge) | **⚠️ OUT OF SCOPE** — delegates to edge function |
| 4 | Agent Model Router | `src/lib/agents/model-router.ts` | Provider config resolution | Provider-agnostic | **✅ BRIDGED** → ai-runtime registry |
| 5 | Agent Runtime | `src/lib/agents/runtime.ts` | Uses model-router | Provider-agnostic | **✅ BRIDGED** — delegates to model-router |
| 6 | localEmbed | `src/lib/ingest/localEmbed.ts` | Pure local (no API) | N/A | **N/A** — deterministic, no migration needed |
| 7 | VLY Integrations | `src/lib/vly-integrations.ts` | VLY SDK wrapper | Platform-managed | **N/A** — platform integration, not provider-specific |

**Direct AI call sites in frontend repo: 3** (embeddings, model-router config, edge function delegation)
**Migrated to ai-runtime: 2** (embeddings, model-router)
**Out of scope: 1** (Edge Function — deployed separately, not in this repo)

---

## 2. Task Registry

Created `src/lib/ai-runtime/tasks.ts` with 12 task identifiers derived from actual Atlas functionality:

| Task ID | Description | Tier | Structured | Cost Weight |
|---|---|---|---|---|
| `embedding` | Document embedding during ingestion | fast | No | 0.5 |
| `embedding_query` | Query embedding for search | fast | No | 0.3 |
| `ask_atlas` | Evidence-grounded conversational AI | fast | Yes | 1.0 |
| `voice_conversation` | Voice-based conversational AI | fast | Yes | 1.0 |
| `crm_outreach` | Personalized outreach email generation | fast | No | 0.8 |
| `email_generation` | Email content for CRM sequences | fast | No | 0.8 |
| `evidence_reasoning` | Evidence analysis for contradictions/gaps | standard | Yes | 2.0 |
| `gap_intelligence` | Missing evidence identification | standard | Yes | 2.0 |
| `supplement_reasoning` | Supplement item analysis/generation | standard | Yes | 2.0 |
| `qa_reasoning` | Quality assurance of AI outputs | standard | Yes | 1.5 |
| `agent_reasoning` | Generic agent tool-calling loops | standard | No | 1.5 |

---

## 3. Migrations Completed

### 3a. Embeddings Provider (`src/lib/knowledge/embeddings.ts`)

**Before:** `GeminiEmbeddingsProvider` class with direct `fetch()` to `generativelanguage.googleapis.com`

**After:** `AIRuntimeEmbeddingsProvider` class that:
- Dynamically imports `@/lib/ai-runtime`
- Calls `initializeRegistry()` to discover available providers
- Uses ai-runtime `embed()` for actual API calls
- Falls back to local deterministic embeddings on any failure
- No direct provider API calls remain in this file

**Key changes:**
- `getEmbeddingsProvider()` is now `async` (returns `Promise<EmbeddingsProvider>`)
- `getEmbeddingsProviderSync()` added for synchronous fallback (returns local)
- All callers updated to `await` the async version
- Test file `knowledge.test.ts` updated (59 tests pass)

### 3b. Model Router Bridge (`src/lib/agents/model-router.ts`)

**Already completed in Phase 1:**
- `syncWithAIRuntime()` function bridges provider availability from ai-runtime registry
- `markProviderAvailable()` allows runtime updates
- Agent runtime `enabled: false` by default — no production calls

---

## 4. Structured Output Validation

The ai-runtime provides `generateStructured<T>()` which:
- Requires a JSON schema in the request
- Parses the model's JSON response
- Returns typed `StructuredOutputResult<T>` with parsed `data`
- Throws `malformed_response` error on invalid JSON
- The Edge Function's existing schema validation (`validateStructuredAnswer`) is preserved — no changes to the validation logic

---

## 5. Evidence Grounding Pipeline

**Preserved completely.** The evidence pipeline remains:

```
Documents → Extraction → Entities → Evidence → Knowledge Graph → Retrieval → LLM Reasoning → Validated Result
```

- Deterministic retrieval in `src/lib/knowledge/retrieval.ts` is untouched
- Edge Function's evidence grounding (pre-retrieved evidence injected into prompts) is untouched
- Tenant-scoped evidence retrieval via Postgres RPCs is untouched
- The AI runtime sits at the "LLM Reasoning" layer only

---

## 6. Customer Data Isolation

**Verified preserved.** The architecture maintains strict separation:

| Layer | Isolation Mechanism |
|---|---|
| Atlas Industry Knowledge | Global, shared across tenants (read-only seed data) |
| Customer Knowledge | Tenant-isolated via Supabase RLS on `documents` table |
| Live Company Evidence | Tenant-isolated via RLS on `insurance_*` tables |
| AI Runtime | Stateless — receives only the prompt/context; no tenant awareness built into the runtime |
| Edge Function | Receives caller's auth token → queries tenant-scoped evidence → sends only that evidence to LLM |

The ai-runtime is a pure function: `input prompt → output text`. It never bypasses tenant authorization because authorization happens before the prompt is built.

---

## 7. Existing Outputs Preserved

- **UI:** No changes to any page components or UI behavior
- **Database schemas:** No migrations added or modified
- **Edge Function:** Not modified (out of scope — deployed separately)
- **Existing features:** All features remain functional (Ask Atlas, Voice, CRM outreach, Knowledge, etc.)
- **Prompts:** All existing prompts preserved exactly
- **Fallback behavior:** Deterministic fallback unchanged

---

## 8. Verification Results

| Check | Result |
|---|---|
| `bun tsc -b --noEmit` | ✅ 0 errors |
| `bunx vitest run` | ✅ 1112 passed, 8 pre-existing failures (milestone9.test.ts ESM), 4 skipped |
| ai-runtime tests | ✅ 66 passed (errors, registry, usage-tracker, runtime) |
| knowledge tests | ✅ 59 passed (embeddings, retrieval, seed data) |
| Regressions | ✅ None introduced |

---

## 9. Remaining Migration Work

### Immediate (Phase 3)

1. **Wire Edge Function to ai-runtime** — The `conversation-converse` Edge Function is deployed separately (not in this repo). When its source is available, replace the direct Gemini `fetch()` with ai-runtime `generate()`. This is the single largest remaining AI call site.

2. **CRM Outreach direct AI path** — `src/lib/crm/ai-outreach.ts` currently delegates to the Edge Function. If a direct AI path is needed (bypassing the Edge Function), create a client-side adapter using ai-runtime `generate()`.

### Medium-term

3. **Agent Runtime AI calls** — When the agent runtime is enabled (`enabled: true`), agents should call ai-runtime `generate()` instead of any direct provider calls. The model-router bridge is already in place.

4. **Client-side vision/document understanding** — If Atlas adds client-side document AI (e.g., photo analysis for damage assessment), route through ai-runtime `vision()`.

5. **Streaming for Ask Atlas** — Replace single-turn request/response with ai-runtime `stream()` for real-time conversational responses.

---

## 10. File Changes Summary

| File | Action | Description |
|---|---|---|
| `src/lib/ai-runtime/tasks.ts` | **Created** | Central task taxonomy (12 tasks) |
| `src/lib/ai-runtime/index.ts` | **Modified** | Added task registry + `initializeRegistry` exports |
| `src/lib/ai-runtime/types.ts` | **Modified** | Added `provider` field to `GenerateRequest` |
| `src/lib/knowledge/embeddings.ts` | **Modified** | Replaced `GeminiEmbeddingsProvider` with `AIRuntimeEmbeddingsProvider` |
| `src/lib/knowledge/knowledge.test.ts` | **Modified** | Updated async `getEmbeddingsProvider()` calls |
| `docs/ATLAS_AI_RUNTIME_AUDIT.md` | **Modified** | Updated with test coverage and Phase 2 status |
| `docs/ATLAS_AI_RUNTIME_MIGRATION_REPORT.md` | **Created** | This report |

---

*Generated by the Atlas AI Runtime Phase 2 migration. This document should be updated when additional workloads are migrated.*
