# Atlas Voice Runtime — Phase 7 Report

## Executive Summary

Phase 7 connects the Atlas Voice Runtime (Phase 6) to the Atlas AI Runtime (Phases 1–5) through a provider-agnostic Voice-AI Bridge. Voice transcripts are classified into intent categories, routed through safety gates, and forwarded to Atlas's existing conversational brain via the `conversation-converse` Edge Function. The system preserves all existing evidence grounding, tenant isolation, and confirmation controls.

**Status: Phase 7 Complete**

---

## Architecture

```
User Speech
    ↓
Browser Web Speech API (STT)
    ↓
Voice Runtime (Phase 6)
    ↓
Voice Bridge (Phase 7)
    ├─ Intent Router — classifies transcript into Atlas task
    ├─ Safety Gates — enforces confirmation for high-risk actions
    └─ Conversation Context — maintains session history
    ↓
Atlas AI Runtime (Phases 1–5)
    ├─ Task Router → Model Registry → Provider Adapter
    ├─ NVIDIA NIM (primary) / Gemini (fallback)
    └─ Structured Output Validation
    ↓
Evidence Grounding Pipeline
    ├─ Evidence Graph
    ├─ Knowledge Retrieval
    └─ Tenant-Scoped Context
    ↓
Grounded Response
    ↓
Voice Runtime (Phase 6)
    ↓
Browser TTS / Server TTS
    ↓
User Hears Response
```

---

## Voice Providers

| Provider | Status | API Key | Fallback |
|----------|--------|---------|----------|
| NVIDIA NIM VoiceChat (Nemotron 3) | Early access/evaluation | `NVIDIA_NIM_API_KEY` (reused from AI Runtime) | Primary when configured |
| Browser Web Speech API | Available in all modern browsers | None needed | Guaranteed fallback |

Provider selection is handled by the Voice Runtime's provider registry. The UI never hard-codes a provider — it queries the runtime for availability.

---

## Voice Intent Routing

The intent router classifies voice transcripts into Atlas task categories using deterministic pattern matching (no AI call required for routing):

### Informational Intents
| Intent | Pattern | Atlas Task |
|--------|---------|------------|
| `get_claim_status` | "status of claim X" | `ask_atlas` |
| `evidence_gaps` | "what evidence is missing" | `ask_atlas` |
| `contradictions` | "are there any contradictions" | `ask_atlas` |

### Analytical Intents
| Intent | Pattern | Atlas Task |
|--------|---------|------------|
| `analyze_claim` | "analyze this claim" | `ask_atlas` |
| `supplement_opportunities` | "find supplement opportunities" | `ask_atlas` |
| `compare_estimate` | "compare the estimate" | `ask_atlas` |
| `summarize_evidence` | "summarize the evidence" | `ask_atlas` |
| `recommendation_reasoning` | "why was this recommendation" | `ask_atlas` |

### Action Intents (require confirmation)
| Intent | Pattern | Action ID |
|--------|---------|-----------|
| `create_supplement` | "create a supplement" | `create_supplement` |
| `send_to_adjuster` | "send to the adjuster" | `send_outreach_email` |
| `generate_package` | "generate claim package" | — |

### Conversational Intents
| Intent | Pattern | Action |
|--------|---------|--------|
| `greeting` | "hello", "hi" | — |
| `help` | "help", "what can you do" | — |
| `repeat` | "say that again" | `replay_last_response` |
| `stop` | "stop", "cancel" | — |

---

## Confirmation / Safety Controls

The safety gate system enforces risk-based confirmation:

| Risk Level | Confirmation Required | Examples |
|------------|----------------------|----------|
| `high_risk_write` | Always | Send email, submit claim package |
| `low_risk_write` | By default (configurable) | Create supplement, upload document |
| `read` | No (by default) | Get claim status, summarize evidence |

**Confirmation rules:**
- Silence, interruption, or ambiguous language is NEVER interpreted as confirmation
- Explicit "yes"/"confirm"/"proceed" is required
- Pending confirmations timeout after 30 seconds
- Maximum 5 pending confirmations per session
- Full audit trail for all confirmation decisions

---

## Tenant Isolation

Voice sessions inherit Atlas authorization:
- Entity context (claim ID) is scoped to the current session
- Pending confirmations are isolated by session ID
- Audit logs track tenant context
- The Voice Bridge does not bypass RLS or tenant boundaries

---

## Conversational Context

The Voice Bridge maintains session-scoped conversation history:
- Up to 20 turns of history (configurable)
- Follow-up detection via pronoun/reference patterns
- History is session-scoped (no cross-session leakage)

---

## Telemetry

Voice telemetry captures (metadata only, no customer content):
- Session ID, provider, model
- Start/end time, duration
- STT/AI/TTS latency
- Success/failure, fallback usage
- Error category, action triggered/confirmed/rejected

---

## Test Results

### Phase 7 Tests (65 tests)

| Category | Tests | Status |
|----------|-------|--------|
| Intent Router — Claim Status | 3 | ✅ Pass |
| Intent Router — Evidence Gaps | 3 | ✅ Pass |
| Intent Router — Contradictions | 2 | ✅ Pass |
| Intent Router — Analytical | 5 | ✅ Pass |
| Intent Router — Actions | 3 | ✅ Pass |
| Intent Router — Conversational | 4 | ✅ Pass |
| Intent Router — General/Empty | 4 | ✅ Pass |
| Intent Router — Entity Extraction | 2 | ✅ Pass |
| Intent Router — Patterns | 1 | ✅ Pass |
| Safety Gates — Requirements | 3 | ✅ Pass |
| Safety Gates — Confirmation Flow | 6 | ✅ Pass |
| Safety Gates — Limits | 1 | ✅ Pass |
| Safety Gates — Audit | 3 | ✅ Pass |
| Voice Bridge — Processing | 5 | ✅ Pass |
| Voice Bridge — History | 3 | ✅ Pass |
| Voice Bridge — Context | 2 | ✅ Pass |
| Voice Bridge — Confirmation | 2 | ✅ Pass |
| Tenant Isolation | 2 | ✅ Pass |
| Synthetic Demo Scenario | 7 | ✅ Pass |
| Error UX | 3 | ✅ Pass |
| Performance | 2 | ✅ Pass |
| **Total** | **65** | **✅ All Pass** |

### Full Test Suite

| Metric | Count |
|--------|-------|
| Total tests | 1,299 |
| Passed | 1,287 |
| Failed | 8 (pre-existing) |
| Skipped | 4 |
| Phase 7 regressions | 0 |

### Pre-existing Failures (unchanged)

| Test | Root Cause |
|------|-----------|
| milestone7.test.ts (4 tests) | ESM `require()` in test |
| milestone7b.test.ts (2 tests) | ESM `require()` in test |
| milestone9.test.ts (2 tests) | ESM `require()` in test |

### TypeScript

| Category | Errors |
|----------|--------|
| Voice Runtime (Phase 7) | 0 |
| Voice Runtime (Phase 6) | 0 |
| AI Runtime providers (pre-existing) | 20 |

---

## Performance

| Operation | Latency |
|-----------|---------|
| Intent classification | < 1ms per query |
| Voice bridge processing | < 5ms per query |
| Full classification + routing pipeline | < 10ms |

---

## Known Limitations

1. **NVIDIA NIM VoiceChat is early-access** — live validation blocked without `NVIDIA_NIM_API_KEY`. Provider contract is validated; live testing deferred to deployment.

2. **Browser STT limitations** — Web Speech API has variable accuracy across browsers. Chrome is best; Safari/Firefox may have reduced accuracy.

3. **Intent classification is pattern-based** — complex multi-intent utterances are classified by best match. Future improvement: ML-based intent classification.

4. **Conversational context is session-scoped** — context does not persist across page reloads (by design for privacy).

5. **TTS latency** — browser TTS has ~100ms startup latency. Server TTS (when configured) is faster but requires additional credentials.

---

## Production Readiness

### ✅ Complete
- Voice intent routing with 16 intent patterns
- Safety gate system with risk-based confirmation
- Voice-AI bridge connecting voice to Atlas AI Runtime
- Conversational context management
- Tenant isolation verification
- Comprehensive test suite (65 tests)
- Synthetic demo scenario
- Performance validated (< 10ms per operation)
- Telemetry integration
- Error UX for all failure modes

### ⚠️ Requires Deployment Verification
- Live NVIDIA NIM VoiceChat validation
- Browser TTS fallback in production
- End-to-end voice → AI → TTS in production environment

### 🔒 Security
- API keys server-side only (never exposed to browser)
- Tenant isolation via session context
- Confirmation audit trail
- No raw audio storage
- No PII in telemetry

---

## Files Created/Modified

### New Files
| File | Purpose |
|------|---------|
| `src/lib/voice-runtime/intent-router.ts` | Voice intent classification |
| `src/lib/voice-runtime/voice-bridge.ts` | Voice-AI bridge connecting to Atlas AI Runtime |
| `src/lib/voice-runtime/safety.ts` | Safety gate system for action confirmation |
| `src/lib/voice-runtime/phase7.test.ts` | 65 comprehensive Phase 7 tests |
| `docs/ATLAS_VOICE_RUNTIME_PHASE7_REPORT.md` | This documentation |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/voice-runtime/index.ts` | Added barrel exports for intent-router, safety, voice-bridge |
| `src/hooks/use-voice.ts` | Added Voice Runtime initialization, entity/page context, runtime status |

---

## Verification Commands

```bash
# TypeCheck
bun tsc -b --noEmit

# Voice Runtime tests (Phase 6 + 7)
bun vitest run src/lib/voice-runtime/

# Full test suite
bun vitest run
```
