# Atlas AI Runtime — Architecture

**Version:** 5.0 (Phases 1–5 complete)
**Date:** 2026-08-28

---

## Overview

Atlas AI Runtime is a provider-agnostic, task-routed AI infrastructure layer. Atlas business logic never calls a specific LLM provider directly — all requests flow through the runtime, which handles provider selection, fallback, retry, structured output validation, and usage tracking.

```
Atlas Application
      ↓
Atlas AI Runtime
      ↓
Task Router
      ↓
Model Registry → Capability Matching
      ↓
Provider Adapter
      ↓
NVIDIA NIM / Gemini / Future Providers
      ↓
Validated AI Result
      ↓
Atlas Evidence / Knowledge / Decision Systems
```

---

## Core Principles

1. **Provider-agnostic**: Atlas features do not know which LLM is behind a request.
2. **Task-routed**: Each workload (evidence reasoning, CRM outreach, embeddings, etc.) is routed to the model best suited for it.
3. **Fallback-safe**: Every critical task has a fallback chain. No single provider failure stops Atlas.
4. **Observable**: Every call is tracked (latency, tokens, cost, success/failure) without logging customer content.
5. **Rollback-capable**: Switching providers is a configuration change, not a code change.

---

## Architecture Layers

### 1. Provider Adapters

Each LLM provider implements the `AIProviderAdapter` interface:

| Method | Purpose |
|---|---|
| `generate()` | Text generation |
| `generateStructured()` | JSON/schema-constrained output |
| `stream()` | Streaming text generation |
| `embed()` | Vector embeddings |
| `vision()` | Image/document understanding |

**Providers implemented:**

| Provider | Status | Protocol | Key Feature |
|---|---|---|---|
| **Gemini** | ✅ Production | REST (Google API) | Embeddings, vision, streaming |
| **NVIDIA NIM** | ✅ Contract-validated | OpenAI-compatible REST | DeepSeek V4 Pro/Flash, Nemotron models |

### 2. Provider Registry

Central registry that:
- Loads provider configs from environment variables
- Tracks provider availability (based on API key presence)
- Enables runtime provider enable/disable
- Provides model lookup across all providers

```
Registry
├── gemini (priority 1) — GEMINI_API_KEY
├── nvidia-nim (priority 2) — NVIDIA_NIM_API_KEY
└── [future providers]
```

### 3. Model Registry

Capability-scored model profiles used for task routing:

| Capability | Score Range | Purpose |
|---|---|---|
| reasoning | 0–10 | Complex evidence/gap analysis |
| structuredOutput | 0–9 | JSON schema compliance |
| streaming | 0–8 | Real-time streaming |
| toolCalling | 0–8 | Function/tool invocation |
| embeddings | 0–8 | Vector embedding quality |
| vision | 0–7 | Image/document understanding |
| documentUnderstanding | 0–9 | OCR, document extraction |
| longContext | 0–9 | >50K token handling |
| speed | 0–9 | Response latency (inverse) |

**Model Health Tracking:**
- Auto-disable after 5 consecutive failures
- Recovery resets failure count
- Admin enable/disable at runtime

### 4. Task Registry & Requirements

Each Atlas workload declares capability requirements:

| Task | Reasoning | Structured | Speed | Context | Cost Limit |
|---|---|---|---|---|---|
| embedding | low | low | high | 0 | $0.001 |
| ask_atlas | medium | high | high | 8K | $0.005 |
| voice_conversation | medium | medium | high | 8K | $0.005 |
| crm_outreach | low | medium | high | 4K | $0.003 |
| evidence_reasoning | high | high | low | 32K | $0.01 |
| gap_intelligence | high | high | low | 32K | $0.01 |
| supplement_reasoning | high | high | low | 32K | $0.01 |
| qa_reasoning | high | high | low | 16K | $0.008 |
| agent_reasoning | high | medium | medium | 16K | $0.01 |

### 5. Task Router

Deterministic routing with three modes:

| Mode | Behavior | Use Case |
|---|---|---|
| `legacy` | Default provider/model | Backward compatibility |
| `single-provider` | Restrict to one provider | Cost control, testing |
| `routed` | Capability-based selection | **Production default** |

**Routing Algorithm:**
1. Filter by cost limit
2. Filter by context window
3. Filter by output tokens
4. Filter by required capabilities
5. Filter by preferred providers
6. Score remaining models (capability match + tier + cost penalty + failure penalty)
7. Select best match
8. Build fallback chain from remaining models

### 6. Task-Aware Runtime

The application-facing API:

```typescript
taskGenerate({ task: "evidence_reasoning", prompt: "..." })
taskGenerateStructured({ task: "supplement_reasoning", prompt: "...", schema: {...} })
taskEmbed({ task: "embedding", texts: [...] })
```

Every result includes routing metadata:
- `routing.model` — Selected model
- `routing.score` — Match quality (0–100)
- `routing.reason` — Human-readable selection reason
- `routing.fallbacks` — Available fallback models
- `fallbackFrom` — Provider if fallback occurred

### 7. Usage Tracking

Every AI call records:
- Provider and model
- Input/output tokens
- Estimated cost (USD)
- Latency (ms)
- Success/failure and error code
- Fallback source
- Task identifier and routing mode

Records are metadata-only — customer prompts and responses are never logged.

---

## Fallback & Error Handling

### Error Classification

| Error Code | Retryable | Behavior |
|---|---|---|
| `timeout` | ✅ | Fallback to next provider |
| `network` | ✅ | Fallback to next provider |
| `rate_limited` | ✅ | Fallback to next provider |
| `provider_error` | ✅ | Fallback to next provider |
| `authentication` | ❌ | Stop chain |
| `missing_api_key` | ❌ | Stop chain |
| `invalid_model` | ❌ | Stop chain |
| `malformed_response` | ❌ | Stop chain |

### Fallback Chain

```
Primary (task-routed model)
  → Fallback 1 (next-best model from routing)
  → Fallback 2 (remaining models)
  → All providers failed → typed error
```

Exponential backoff: 1s → 2s → 4s (max 30s).

### Circuit Breaker

Models are auto-disabled after 5 consecutive failures. The model registry tracks health state and re-enables on recovery.

---

## Security

| Concern | Mitigation |
|---|---|
| API keys | Server-side only, never in browser bundle, never in logs |
| Customer data | Tenant isolation via RLS + runtime boundary |
| Prompts | Not logged by default (usage tracker records metadata only) |
| Model responses | Validated via structured output schemas before use |
| Provider errors | Sanitized — API keys redacted from error messages |
| Rate limits | Handled via fallback chain, not hard crashes |

---

## Rollback

Switching providers is purely configuration:

```bash
# Force all traffic to Gemini
ATLAS_AI_PROVIDER=gemini

# Disable routing, use legacy provider priority
ATLAS_AI_ROUTING_MODE=legacy

# Restrict to single provider
ATLAS_AI_ROUTING_MODE=single-provider
singleProviderId=gemini
```

No code changes required. No redeployment required (env vars are runtime-read).

---

## Environment Variables

```bash
# --- Gemini (existing provider / fallback) ---
GEMINI_API_KEY=              # Required for Gemini provider
GEMINI_MODEL=gemini-2.5-flash  # Default Gemini model

# --- NVIDIA NIM (preferred for reasoning tasks) ---
NVIDIA_NIM_API_KEY=          # Required for NVIDIA provider
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_DEFAULT_MODEL=deepseek-ai/deepseek-v4-pro

# --- Runtime configuration ---
ATLAS_AI_PROVIDER=           # Override: "gemini" | "nvidia-nim" (empty = routed)
ATLAS_AI_ROUTING_MODE=routed  # "routed" | "legacy" | "single-provider"
```

---

## Files

### Core Runtime
| File | Purpose |
|---|---|
| `src/lib/ai-runtime/index.ts` | Barrel export — single import point |
| `src/lib/ai-runtime/types.ts` | Core type definitions |
| `src/lib/ai-runtime/config.ts` | Environment-based provider configuration |
| `src/lib/ai-runtime/runtime.ts` | Main runtime facade (generate, embed, vision, etc.) |
| `src/lib/ai-runtime/registry.ts` | Provider registry |
| `src/lib/ai-runtime/errors.ts` | Typed error handling |
| `src/lib/ai-runtime/usage-tracker.ts` | Usage/cost tracking |

### Providers
| File | Purpose |
|---|---|
| `src/lib/ai-runtime/providers/gemini.ts` | Gemini REST API adapter |
| `src/lib/ai-runtime/providers/nvidia-nim.ts` | NVIDIA NIM OpenAI-compatible adapter |

### Task Routing
| File | Purpose |
|---|---|
| `src/lib/ai-runtime/tasks.ts` | Task identifier registry |
| `src/lib/ai-runtime/task-requirements.ts` | Capability requirements per task |
| `src/lib/ai-runtime/model-registry.ts` | Model capability profiles |
| `src/lib/ai-runtime/task-router.ts` | Deterministic task→model routing |
| `src/lib/ai-runtime/task-runtime.ts` | Task-aware runtime facade |

### Evaluation
| File | Purpose |
|---|---|
| `src/lib/ai-runtime/eval/types.ts` | Evaluation data structures |
| `src/lib/ai-runtime/eval/dataset.ts` | Benchmark dataset (synthetic, no real data) |
| `src/lib/ai-runtime/eval/criteria.ts` | Scoring functions |
| `src/lib/ai-runtime/eval/runner.ts` | Benchmark execution engine |
| `src/lib/ai-runtime/eval/scorecard.ts` | Scorecard generation |
| `src/lib/ai-runtime/eval/router-integration.ts` | Scorecard → routing suggestions |

### Tests
| File | Tests |
|---|---|
| `src/lib/ai-runtime/runtime.test.ts` | Runtime facade, fallback, usage |
| `src/lib/ai-runtime/registry.test.ts` | Provider registry |
| `src/lib/ai-runtime/errors.test.ts` | Error classification |
| `src/lib/ai-runtime/usage-tracker.test.ts` | Usage tracking |
| `src/lib/ai-runtime/task-router.test.ts` | Task routing (36 tests) |
| `src/lib/ai-runtime/eval/eval.test.ts` | Evaluation framework |

### Admin
| File | Purpose |
|---|---|
| `src/components/admin/ai-runtime-status.tsx` | Runtime status dashboard |

### Documentation
| File | Purpose |
|---|---|
| `docs/ATLAS_AI_RUNTIME_AUDIT.md` | Phase 1 audit |
| `docs/ATLAS_AI_RUNTIME_MIGRATION_REPORT.md` | Phase 2 migration report |
| `docs/ATLAS_AI_RUNTIME_PHASE3_REPORT.md` | Phase 3 routing report |
| `docs/ATLAS_AI_ARCHITECTURE.md` | This document |

---

## What Atlas Proprietary Intelligence Resides Outside the Runtime

The AI Runtime is infrastructure. Atlas's competitive intelligence lives in:

- **Knowledge Layer**: Industry corpus, regulations, workflows, insurance data
- **Evidence Graph**: Document→Entity→Evidence→Claim relationships
- **Evidence Reasoning Engine**: Gap detection, contradiction analysis, completeness scoring
- **Decision Engine**: Recommendation state machine, approval workflows
- **Agent Runtime**: Specialized agents (evidence, gap, supplement, QA)
- **Task-specific prompts**: Domain-tuned for insurance restoration
- **Schemas**: Structured output validation for every AI task
- **Evaluation framework**: Benchmark dataset and scoring criteria
- **Customer context**: Tenant-scoped evidence, claims, and knowledge
- **Workflow logic**: Ingestion → extraction → analysis → recommendations

These are provider-agnostic by design — they work identically whether powered by Gemini, DeepSeek, or a future model.
