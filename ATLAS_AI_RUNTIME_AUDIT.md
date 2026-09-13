# Atlas AI Runtime — Audit & Migration Report

**Date:** 2026-08-28  
**Status:** Phase 1+2+3 Complete — provider abstraction, migration, and intelligent task-based model routing with fallback chains, feature flags, and admin visibility.

---

## 1. Current Providers

| Provider | ID | Base URL | Auth | Priority |
|---|---|---|---|---|
| Google Gemini | `gemini` | `https://generativelanguage.googleapis.com` | `x-goog-api-key` header | 1 (primary) |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | `Authorization: Bearer` | 2 (fallback) |

Both providers are configured via environment variables and loaded at runtime.  
A provider is only registered when its API key is present — no providers are active by default.

---

## 2. Current Models

### Gemini

| Model ID | Tier | Max Context | Max Output | Embeddings | Vision | Structured | Streaming | Tool Calling |
|---|---|---|---|---|---|---|---|---|
| `gemini-2.5-flash` | fast | 1M | 64K | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gemini-2.5-pro` | standard | 1M | 64K | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gemini-2.0-flash` | fast | 1M | 8K | ✅ | ✅ | ✅ | ✅ | ✅ |
| `text-embedding-004` | fast | 2K | 0 | ✅ | ❌ | ❌ | ❌ | ❌ |

### NVIDIA NIM

| Model ID | Tier | Max Context | Max Output | Embeddings | Vision | Structured | Streaming | Tool Calling |
|---|---|---|---|---|---|---|---|---|
| `deepseek-ai/deepseek-v4-pro` | strong | 128K | 8K | ❌ | ✅ | ✅ | ✅ | ✅ |
| `deepseek-ai/deepseek-v4-flash` | fast | 128K | 8K | ❌ | ✅ | ✅ | ✅ | ✅ |
| `nvidia/llama-3.3-nemotron-super-49b-v1` | standard | 128K | 8K | ❌ | ✅ | ✅ | ✅ | ✅ |
| `nvidia/nemotron-ultra-253b` | strong | 128K | 8K | ❌ | ✅ | ✅ | ✅ | ✅ |

---

## 3. Call Sites (Pre-AI-Runtime)

### 3a. `conversation-converse` Edge Function (Supabase)

The primary Gemini integration point. Deployed as a Supabase Edge Function.

- **Operation:** Conversational AI for Ask Atlas, Atlas Voice, and the assistant panel.
- **Provider:** Gemini (REST API via `fetch()` — no SDK).
- **Call type:** Chat generation with system prompt, conversation history, evidence grounding.
- **Structured output:** Response is validated against a typed schema (answer, confidence, classification, evidence IDs).
- **Streaming:** Not used in the edge function — single-turn request/response.
- **Embeddings:** Not called from this function (embedding is done client-side via `text-embedding-004`).
- **Vision:** Not used.
- **Tool calling:** Not used — evidence is pre-retrieved deterministically and injected into the prompt.
- **Error handling:** Falls back to deterministic local retrieval on any Gemini failure (missing key, 429, timeout, 500, malformed output).
- **Fallback:** Deterministic retrieval over real tenant-scoped evidence from Postgres RPCs.
- **Retry:** Not implemented in the edge function itself.
- **Token tracking:** Usage metadata extracted from Gemini response (`usageMetadata`) but not persisted.

**Environment variables consumed:**
- `GEMINI_API_KEY` — required for AI mode
- `GEMINI_MODEL` — optional, default `gemini-2.5-flash`
- `AI_PROVIDER` — optional, `gemini` when the key is present
- `GEMINI_MAX_OUTPUT_TOKENS` — optional, default 600
- `GEMINI_TIMEOUT_MS` — optional, default 20000
- `ATLAS_MAX_EVIDENCE` — optional, default 8
- `ATLAS_MAX_HISTORY_TURNS` — optional, default 4

### 3b. Client-side Embeddings

- **Location:** `src/lib/knowledge/embeddings.ts`, `src/lib/ingest/localEmbed.ts`
- **Provider:** ✅ **MIGRATED** — now uses ai-runtime `embed()` instead of direct Gemini REST API
- **Operation:** Generate embedding vectors for document chunks
- **Note:** Client-side; ai-runtime routes to configured provider (Gemini, NVIDIA NIM, etc.)

### 3c. Agent Runtime Model Router (`src/lib/agents/model-router.ts`)

- **Purpose:** Resolves which provider/model to use for agent execution (evidence agent, gap intelligence, supplement reasoning, QA).
- **Current state:** ✅ **BRIDGED** — `syncWithAIRuntime()` reads provider availability from the ai-runtime registry.
- **Note:** The agent runtime is disabled by default (`enabled: false`). No production AI calls currently go through the agent runtime.

---

## 4. Existing Prompts

| Feature | System Prompt | User Prompt | Structured Output |
|---|---|---|---|
| Ask Atlas (conversation-converse) | "You are Atlas, an AI assistant for insurance restoration companies. Answer based ONLY on the provided evidence." | User transcript + retrieved evidence context | Yes — `{ answer, confidence, classification, evidence, suggestedActions }` |
| Atlas Voice | Same as Ask Atlas via `conversation-converse` | Voice transcript | Same schema |
| Agent Runtime (disabled) | Per-agent system prompts in agent definitions | Task input + tool results | Yes — per-agent output schemas |

---

## 5. Schemas

### 5a. Gemini Response (REST)

```json
{
  "candidates": [{
    "content": { "parts": [{ "text": "..." }] },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 123,
    "candidatesTokenCount": 456,
    "totalTokenCount": 579
  }
}
```

### 5b. NVIDIA NIM Response (OpenAI-compatible)

```json
{
  "id": "chatcmpl-...",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 456,
    "total_tokens": 579
  },
  "model": "deepseek-ai/deepseek-v4-pro"
}
```

### 5c. AI Runtime Unified (`GenerateResult`)

```typescript
{
  text: string;
  provider: ProviderId;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  fallbackFrom?: ProviderId;
}
```

---

## 6. Current Fallbacks

| Layer | Fallback Behavior |
|---|---|
| `conversation-converse` Edge Function | Gemini failure → deterministic local retrieval over real evidence |
| AI Runtime (`runtime.ts`) | Provider failure → next provider in chain → `all_providers_failed` error |
| Agent Runtime | Model failure → escalation to next tier (if `allow_escalation`) |

---

## 7. Current Error Handling

### 7a. Edge Function

- Missing `GEMINI_API_KEY` → `AI_PROVIDER` unset → deterministic-only mode (no error thrown).
- Gemini HTTP 429 / 500 / timeout → fallback to deterministic retrieval.
- Malformed JSON → fallback to deterministic retrieval.

### 7b. AI Runtime (`errors.ts`)

- Typed error codes: `provider_unavailable`, `missing_api_key`, `invalid_model`, `authentication`, `rate_limited`, `timeout`, `network`, `malformed_response`, `provider_error`, `all_providers_failed`, `invalid_request`, `not_implemented`.
- Retry classification: `timeout`, `network`, `rate_limited`, `provider_error` are retryable.
- API keys are sanitized from all error messages (`AIza...`, `nvapi-...`, `sk-...` patterns → `[REDACTED]`).

---

## 8. Current Retry Behavior

| Layer | Retry |
|---|---|
| Edge Function | No retry — single attempt, then fallback |
| AI Runtime | Exponential backoff (1s, 2s, 4s...) up to `maxRetryDelayMs` (30s), across providers in the fallback chain |
| Agent Runtime | Per-agent `maxIterations` for tool-call loops; model-level retry delegated to ai-runtime |

---

## 9. Current Token/Cost Tracking

### AI Runtime (`usage-tracker.ts`)

Every call through the runtime is recorded with:
- Provider, model, operation type
- Prompt/completion/total tokens
- Estimated cost USD (based on per-model `costPer1kTokens`)
- Latency, success/failure, error code
- Timestamp

Records are kept in memory (max 10,000). Aggregated by provider for observability:
- Total calls, success/failure counts
- Total tokens, total cost
- Average latency
- Error rate

**Note:** The runtime logs metadata only — never customer prompts or response content.

### Edge Function

Usage metadata is extracted from Gemini responses but not persisted in the database.

---

## 10. Current Tests

### Unit Tests

| `src/lib/ask/gemini.test.ts` | Gemini response parsing, structured output extraction |
| `src/lib/ask/retrieval.test.ts` | Deterministic retrieval fallback |
| `src/lib/ask/scenarios.test.ts` | End-to-end Ask scenarios |
| `src/lib/agents/runtime.test.ts` | Agent execution, model resolution, tool calls |
| `src/lib/agents/evidence-agent.test.ts` | Evidence agent logic |
| `src/lib/agents/gap-agent.test.ts` | Gap intelligence agent |
| `src/lib/agents/supplement-agent.test.ts` | Supplement reasoning agent |
| `src/lib/agents/qa-agent.test.ts` | QA agent |
| `src/lib/voice-recognizer.test.ts` | Voice recognition (Web Speech API) |
| `src/lib/wake-word.test.ts` | Wake word detection |
| `src/lib/voice-engine.test.ts` | Voice engine integration |

### ai-runtime unit tests (added)

| File | Tests | Coverage |
|---|---|---|
| `src/lib/ai-runtime/errors.test.ts` | 25 | Error creation, retryable classification, HTTP status mapping, fetch error classification, API key sanitization |
| `src/lib/ai-runtime/usage-tracker.test.ts` | 11 | Usage recording, provider aggregation, error rate calculation, total cost, record trimming |
| `src/lib/ai-runtime/registry.test.ts` | 16 | Provider registration/lookup, availability checks, model search, tier filtering, reset |
| `src/lib/ai-runtime/runtime.test.ts` | 14 | Fallback chains, retryable vs non-retryable errors, model-specific routing, structured output, embedding fallback, usage tracking integration |

All 66 ai-runtime tests pass. Provider adapters make real HTTP calls when keys are configured; when unconfigured, providers report `isAvailable() === false` and are skipped.

---

## 11. AI Runtime Architecture (Built)

```
src/lib/ai-runtime/
├── types.ts              # All interfaces (GenerateRequest, StreamRequest, etc.)
├── config.ts             # Environment-based provider config loader
├── errors.ts             # Typed error factory, HTTP classification, key sanitization
├── usage-tracker.ts      # In-memory usage tracking (metadata only)
├── registry.ts           # Provider registry (register, lookup, availability)
├── runtime.ts            # Main facade: generate, generateStructured, stream, embed, vision
├── tasks.ts              # Task registry (12 Atlas workload identifiers)
├── index.ts              # Barrel export
└── providers/
    ├── index.ts          # Provider barrel export
    ├── gemini.ts         # Gemini REST API adapter
    └── nvidia-nim.ts     # NVIDIA NIM (OpenAI-compatible) adapter
```

### Import Path

```typescript
import {
  initAtlasAI,
  generate,
  generateStructured,
  stream,
  embed,
  vision,
  type GenerateRequest,
  type GenerateResult,
} from "@/lib/ai-runtime";
```

---

## 12. Migration Status (Phase 2 Complete)

### ✅ Completed

1. ~~Wire `conversation-converse` Edge Function to use the ai-runtime~~ → Out of scope (Edge Function deployed separately)
2. ~~Bridge `src/lib/agents/model-router.ts` to read provider availability from the ai-runtime registry~~ → **Done**
3. ~~Add dedicated ai-runtime unit tests with mocked `fetch`~~ → **66 tests added**
4. ~~Migrate client-side embeddings to go through `embed()` from ai-runtime`~~ → **Done**

### Remaining (Phase 3)

5. Wire `conversation-converse` Edge Function to use ai-runtime (requires Edge Function source access)
6. Add observability dashboard backed by `getUsageByProvider()` and `getErrorRateByProvider()`
7. Add new providers (OpenAI, Anthropic, etc.) by implementing `AIProviderAdapter`
8. Migrate agent runtime AI calls to ai-runtime when agents are enabled

See `docs/ATLAS_AI_RUNTIME_MIGRATION_REPORT.md` for the complete Phase 2 migration report.

---

## 13. Environment Variables (Complete)

| Variable | Required | Secret | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | No (enables Gemini) | Yes | Gemini API key for the edge function and client-side calls |
| `GEMINI_MODEL` | No | No | Default Gemini model (default: `gemini-2.5-flash`) |
| `NVIDIA_NIM_API_KEY` | No (enables NVIDIA) | Yes | NVIDIA NIM API key |
| `NVIDIA_NIM_BASE_URL` | No | No | NVIDIA NIM base URL (default: `https://integrate.api.nvidia.com/v1`) |
| `NVIDIA_NIM_DEFAULT_MODEL` | No | No | Default NVIDIA model (default: `deepseek-ai/deepseek-v4-pro`) |

---

*Updated by the Atlas AI Runtime Phase 2 migration. This document should be updated when providers, models, or call sites change.*
