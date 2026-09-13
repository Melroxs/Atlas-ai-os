# Atlas AI Runtime — Phase 3 Report: Task-Based Model Routing

**Date:** 2026-08-28
**Status:** Phase 3 Complete — intelligent task-based model routing with fallback chains, feature flags, and admin visibility.

---

## 1. Model Registry

**File:** `src/lib/ai-runtime/model-registry.ts`

Centralized registry tracking all available models and their routing capabilities.

| Capability | Score Range | Purpose |
|---|---|---|
| reasoning | 0-10 | Complex reasoning tasks (evidence, gap analysis) |
| structuredOutput | 0-9 | JSON/schema output quality |
| streaming | 0-8 | Real-time response streaming |
| toolCalling | 0-8 | Function/tool invocation quality |
| embeddings | 0-8 | Vector embedding capability |
| vision | 0-7 | Image/document understanding |
| documentUnderstanding | 0-9 | OCR, document extraction |
| longContext | 0-9 | >50K token handling |
| speed | 0-9 | Response latency (inverse) |

### Model Scoring

| Model | Tier | Reasoning | Structured | Tool | Speed | Embeddings |
|---|---|---|---|---|---|---|
| gemini-2.5-flash | fast | 4 | 7 | 8 | 9 | 8 |
| gemini-2.5-pro | standard | 6 | 8 | 8 | 6 | 8 |
| gemini-2.0-flash | fast | 4 | 7 | 8 | 9 | 8 |
| text-embedding-004 | fast | 4 | 0 | 0 | 9 | 8 |
| deepseek-v4-pro | strong | 8 | 9 | 8 | 4 | 0 |
| deepseek-v4-flash | fast | 4 | 7 | 8 | 9 | 0 |
| nemotron-super-49b | standard | 6 | 8 | 8 | 6 | 0 |
| nemotron-ultra-253b | strong | 8 | 9 | 8 | 4 | 0 |

### Features
- **Auto-disable**: Models disabled after 5 consecutive failures
- **Health tracking**: Success/failure counts reset on recovery
- **Admin control**: Enable/disable individual models at runtime

---

## 2. Task Requirements

**File:** `src/lib/ai-runtime/task-requirements.ts`

Defines capability requirements for each Atlas AI task.

| Task | Reasoning | Structured | Tool | Speed | Context | Cost Limit |
|---|---|---|---|---|---|---|
| embedding | low | low | low | high | 0 | $0.001 |
| embedding_query | low | low | low | high | 0 | $0.001 |
| ask_atlas | medium | high | medium | high | 8K | $0.005 |
| voice_conversation | medium | medium | medium | high | 8K | $0.005 |
| crm_outreach | low | medium | low | high | 4K | $0.003 |
| email_generation | low | medium | low | high | 4K | $0.003 |
| evidence_reasoning | high | high | medium | low | 32K | $0.01 |
| gap_intelligence | high | high | medium | low | 32K | $0.01 |
| supplement_reasoning | high | high | medium | low | 32K | $0.01 |
| qa_reasoning | high | high | low | low | 16K | $0.008 |
| agent_reasoning | high | medium | high | medium | 16K | $0.01 |

### Capability Requirements
- `required: true` — Model must meet minimum score or task is rejected
- `weight` — Relative importance for scoring (0-10)
- `level` — Minimum capability level: low(2), medium(5), high(8)

---

## 3. Task Router

**File:** `src/lib/ai-runtime/task-router.ts`

Deterministic routing with three modes:

### Routing Modes

| Mode | Behavior | Use Case |
|---|---|---|
| `legacy` | Default provider/model selection | Backward compatibility |
| `single-provider` | Restrict to one provider | Cost control, testing |
| `routed` | Intelligent capability-based selection | **Production default** |

### Routing Algorithm
1. **Filter by cost limit** — Exclude models above max cost
2. **Filter by context window** — Exclude models below task minimum
3. **Filter by output tokens** — Exclude models below task minimum
4. **Filter by required capabilities** — Exclude models failing required checks
5. **Filter by preferred providers** — Prefer specified providers if available
6. **Score remaining models** — Weighted capability match + tier preference + cost penalty + failure penalty
7. **Select best match** — Highest score wins
8. **Build fallback chain** — Remaining models sorted by score

### Fallback Behavior
- Fallback chain: Primary → fallbacks from scoring
- Retryable errors trigger fallback: 429, timeout, 5xx, provider unavailable
- Non-retryable errors stop chain: auth failure, invalid model, malformed response
- Exponential backoff between providers (1s → 2s → 4s, max 30s)

---

## 4. Task-Aware Runtime

**File:** `src/lib/ai-runtime/task-runtime.ts`

Extends base runtime with task-based routing:

```
Atlas Feature
    ↓
taskGenerate({ task: "evidence_reasoning", ... })
    ↓
Task Router → selects optimal model + provider
    ↓
Provider Chain → primary → fallbacks
    ↓
Result + Routing Metadata
```

### Available Functions
- `taskGenerate(request)` — Text generation with task routing
- `taskGenerateStructured<T>(request)` — Structured output with task routing
- `taskEmbed(request)` — Embeddings with task routing

### Routing Metadata
Every result includes:
- `routing.model` — Selected model
- `routing.score` — Match quality (0-100)
- `routing.reason` — Human-readable selection reason
- `routing.fallbacks` — Available fallback models
- `fallbackFrom` — Provider if fallback occurred

---

## 5. Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| `mode` | `routed` | Routing mode (legacy/single-provider/routed) |
| `preferCostOptimized` | `false` | Bias toward lower-cost models |
| `maxCostPer1kTokens` | `0.01` | Hard cost ceiling |
| `enableFallback` | `true` | Allow fallback chain |
| `singleProviderId` | — | Restrict to one provider |

### Runtime Config
```typescript
updateRoutingConfig({
  mode: "single-provider",
  singleProviderId: "gemini",
  maxCostPer1kTokens: 0.005,
});
```

---

## 6. Observability

### Usage Tracking (per call)
- Task identifier
- Provider used
- Model used
- Input/output tokens
- Estimated cost (USD)
- Latency (ms)
- Success/failure
- Error code (if failed)
- Fallback source (if applicable)
- Routing mode

### Model Health
- Consecutive failure count
- Auto-disable threshold (5 failures)
- Last successful request timestamp

### Status API
```typescript
const status = getRoutingStatus();
// { mode, config, modelRegistry: { totalModels, availableModels, disabledModels, modelsWithFailures, byProvider } }
```

---

## 7. Admin Visibility

**File:** `src/components/admin/ai-runtime-status.tsx`

Internal status dashboard showing:
- **Routing mode** — Current mode with change controls
- **Model registry** — All models, availability, health, cost
- **Provider status** — Model counts, cost, error rates
- **Usage summary** — Total cost, active providers

---

## 8. Tests

**File:** `src/lib/ai-runtime/task-router.test.ts` — 36 tests

### Test Coverage

| Category | Tests |
|---|---|
| Model Registry | 12 |
| Task Requirements | 6 |
| Task Router | 14 |
| Integration | 4 |

### Test Scenarios
- ✅ Model initialization from providers
- ✅ Capability scoring and matching
- ✅ Auto-disable on repeated failures
- ✅ Admin enable/disable
- ✅ Task routing to best model
- ✅ Fallback chain construction
- ✅ Legacy mode routing
- ✅ Single-provider mode routing
- ✅ Cost limit enforcement
- ✅ Context window requirements
- ✅ Disabled model exclusion
- ✅ All-providers-disabled handling
- ✅ Embedding model preference (Gemini-only)
- ✅ High-reasoning tasks → strong models
- ✅ Fast tasks → fast models
- ✅ Status reporting

---

## 9. Current Default Routing Configuration

```typescript
{
  mode: "routed",
  preferCostOptimized: false,
  maxCostPer1kTokens: 0.01,
  enableFallback: true,
}
```

### Default Task Routing Results

| Task | Selected Model | Provider | Score | Reason |
|---|---|---|---|---|
| embedding | text-embedding-004 | gemini | 95 | Only embedding-capable model |
| ask_atlas | gemini-2.5-flash | gemini | 85 | Fast + structured output + low cost |
| evidence_reasoning | deepseek-v4-pro | nvidia-nim | 90 | Strong reasoning + structured output |
| agent_reasoning | deepseek-v4-pro | nvidia-nim | 88 | Strong reasoning + tool calling |
| crm_outreach | gemini-2.5-flash | gemini | 92 | Fast + low cost |
| voice_conversation | gemini-2.5-flash | gemini | 88 | Fast + speed requirement |

---

## 10. Files Created/Modified

| File | Action | Description |
|---|---|---|
| `src/lib/ai-runtime/model-registry.ts` | **Created** | Centralized model capability registry |
| `src/lib/ai-runtime/task-requirements.ts` | **Created** | Task capability requirements |
| `src/lib/ai-runtime/task-router.ts` | **Created** | Deterministic routing with fallbacks |
| `src/lib/ai-runtime/task-runtime.ts` | **Created** | Task-aware runtime facade |
| `src/lib/ai-runtime/task-router.test.ts` | **Created** | 36 comprehensive tests |
| `src/lib/ai-runtime/index.ts` | **Modified** | Added Phase 3 exports |
| `src/components/admin/ai-runtime-status.tsx` | **Created** | Admin visibility component |

---

## 11. Verification Results

| Check | Result |
|---|---|
| `bun tsc -b --noEmit` | ✅ 0 errors |
| `bunx vitest run` | ✅ 1148 passed, 8 pre-existing failures (milestone9.test.ts ESM) |
| task-router tests | ✅ 36 passed |
| ai-runtime total tests | ✅ 102 passed (66 Phase 1-2 + 36 Phase 3) |
| Regressions | ✅ None introduced |

---

## 12. What Remains (Future Phases)

| Phase | Description |
|---|---|
| Phase 4 | Benchmark models on actual Atlas tasks (ground truth scoring) |
| Phase 5 | Dynamic routing based on benchmark results |
| Phase 6 | Cost budgeting per tenant/workload |
| Phase 7 | A/B testing infrastructure for model comparison |
| Phase 8 | Auto-scaling routing rules based on performance data |

---

*Generated by Atlas AI Runtime Phase 3. This document should be updated when routing rules, models, or capabilities change.*
