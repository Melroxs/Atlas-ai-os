// ---------------------------------------------------------------------------
// Content Engine — NVIDIA NIM model selection
//
// THE DEFECTS THIS EXISTS TO CATCH
// --------------------------------
// Two different failures have reached this line, and only the second is
// subtle enough to be worth its own test:
//
// 1. `deepseek-ai/deepseek-v4-pro` was RETIRED. It answers HTTP 410 Gone at
//    Atlas's endpoint, so `generateArticle()` failed with NOT_CONFIGURED
//    before writing anything.
//
// 2. `deepseek-ai/deepseek-v4.1-flash` is still LISTED by `GET /v1/models`
//    but is not being SERVED. The gateway accepts the request and then returns
//    no headers, no status and no body — for 90s in the Edge Function and for
//    120s in local diagnostics. That was proven to be specific to that model
//    id, not to Atlas: the same endpoint, key and runtime answer a different id
//    in well under a second, a retired id answers 410, an unentitled id answers
//    404, and NVIDIA's own first-party Playground fails the same way.
//
//    The lesson this file must not forget: PRESENCE IN THE CATALOG IS NOT
//    EVIDENCE OF SERVICE. A model can be advertised and dead at the same time,
//    so "it is still in /v1/models" can never justify leaving it in place.
//
// The fallback is what actually runs, because `NVIDIA_NIM_DEFAULT_MODEL` is not
// set in the project — so a stale id there is not a dead comment, it is the
// model every article regeneration requests.
//
// These tests read the worker's real declaration and cross-check it against the
// AI runtime's, so the two can never silently diverge on WHICH variable selects
// the model. They assert the whole chain:
//
//     NVIDIA_NIM_DEFAULT_MODEL -> NIM_MODEL -> request body `model:`
//
// They deliberately do NOT ban any id from the whole repository: audit reports
// and historical documentation legitimately name the models that were proven
// unavailable, and erasing that history would be its own kind of lie. What must
// never come back is the EXECUTABLE fallback.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NIM_ARTICLE_DEFAULT_TIMEOUT_MS } from "../../../supabase/functions/content-engine-worker/provider-deadline";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = readFileSync(
  resolve(HERE, "../../../supabase/functions/content-engine-worker/index.ts"),
  "utf8",
);
const RUNTIME = readFileSync(resolve(HERE, "../ai-runtime/config.ts"), "utf8");

/**
 * Executable source: block comments and whole-line `//` comments removed.
 *
 * Only whole-line comments are dropped, because an inline `//` also occurs
 * inside real code (the base URL, the `replace(/\/+$/, "")` regex), and this
 * worker documents the unserved model in a comment that must not be mistaken
 * for the executable fallback.
 */
function executable(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const WORKER_CODE = executable(WORKER);
const RUNTIME_CODE = executable(RUNTIME);

/** `const NIM_MODEL = env("VAR") ?? "fallback";` — the worker's selection site. */
function selection(src: string, constName: string): { variable: string; fallback: string } {
  const m = src.match(
    new RegExp(`const ${constName} = env\\("([A-Z0-9_]+)"\\) \\?\\? "([^"]+)"`),
  );
  expect(m, `${constName} must be declared as env("VAR") ?? "fallback"`).not.toBeNull();
  return { variable: (m as RegExpMatchArray)[1], fallback: (m as RegExpMatchArray)[2] };
}

const AUTHORIZED_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const UNSERVED_MODEL = "deepseek-ai/deepseek-v4.1-flash";

describe("content engine — the NVIDIA model fallback is a live model", () => {
  const model = selection(WORKER_CODE, "NIM_MODEL");

  it("1. defaults to the explicitly authorized model", () => {
    expect(model.fallback).toBe(AUTHORIZED_MODEL);
  });

  it("is a real provider/model identifier, not a placeholder", () => {
    expect(model.fallback).toMatch(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/);
    expect(model.fallback.toLowerCase()).not.toMatch(/default|placeholder|todo|changeme|unknown/);
  });

  it("2. no longer falls back to the model that is listed but never served", () => {
    expect(model.fallback).not.toBe(UNSERVED_MODEL);
    expect(model.fallback).not.toMatch(/^deepseek-ai\/deepseek-v4\.1-flash$/);
    // …and it does not survive anywhere else in the EXECUTABLE worker source.
    // The comment above still names it, on purpose, and that is not a match.
    expect(WORKER_CODE).not.toContain(UNSERVED_MODEL);
  });

  it("3. lets an explicit NVIDIA_NIM_DEFAULT_MODEL override still win", () => {
    // The declaration itself is the proof: `env(...)` is the LEFT operand of
    // `??`, so a configured value is used and the fallback is reached only when
    // the variable is unset. Reversed order would silently ignore the override.
    expect(WORKER_CODE).toContain(
      `const NIM_MODEL = env("NVIDIA_NIM_DEFAULT_MODEL") ?? "${AUTHORIZED_MODEL}";`,
    );
    expect(model.variable).toBe("NVIDIA_NIM_DEFAULT_MODEL");
  });

  it("4. keeps NVIDIA_NIM_DEFAULT_MODEL as the single override", () => {
    // The override must be consulted FIRST: never `"model" ?? env(...)`.
    expect(WORKER_CODE).not.toMatch(
      new RegExp(`"${model.fallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\?\\?`),
    );
    // Exactly one model-selection site — no second mechanism.
    expect(
      WORKER_CODE.match(/NVIDIA_NIM_DEFAULT_MODEL"\) \?\? "[^"]+"/g) ?? [],
    ).toHaveLength(1);
    expect(WORKER_CODE.match(/const NIM_MODEL/g) ?? []).toHaveLength(1);
  });

  it("never falls back to a model NVIDIA has retired", () => {
    // Covers `deepseek-ai/deepseek-v4-pro` AND `…-v4-pro-0813` (prefix match).
    expect(model.fallback).not.toMatch(/^deepseek-ai\/deepseek-v4-pro/);
    expect(model.fallback).not.toMatch(/^deepseek-ai\/deepseek-v4-flash-0731$/);
    // …and no retired id survives anywhere else in the executable source.
    expect(WORKER_CODE).not.toMatch(/deepseek-ai\/deepseek-v4-pro/);
    expect(WORKER_CODE).not.toMatch(/deepseek-ai\/deepseek-v4-flash-0731/);
  });

  it("reads the SAME configuration variable as the AI runtime", () => {
    // One shared mechanism, not two. The AI runtime's own fallback VALUE is a
    // separate reported concern and is deliberately NOT asserted here: pinning
    // it would expand this phase's scope. Only the shared variable NAME is
    // pinned, which is what keeps the override coherent across both call sites.
    const runtime = RUNTIME_CODE.match(
      /const defaultModel = \(env\("([A-Z0-9_]+)"\) \?\? "([^"]+)"\)\.trim\(\)/,
    );
    expect(runtime).not.toBeNull();
    expect((runtime as RegExpMatchArray)[1]).toBe(model.variable);
  });

  it("5. wires the selected model into the chat-completions request body", () => {
    // The value must actually reach the provider, not just be declared.
    expect(WORKER_CODE).toMatch(/model: NIM_MODEL,/);
    expect(WORKER_CODE).toContain("/chat/completions");
    // …on the NVIDIA NIM base URL, unchanged by this phase.
    const base = selection(WORKER_CODE, "NIM_BASE");
    expect(base.variable).toBe("NVIDIA_NIM_BASE_URL");
    expect(base.fallback).toBe("https://integrate.api.nvidia.com/v1");
    expect(RUNTIME_CODE).toContain("https://integrate.api.nvidia.com/v1");
  });

  it("6. changes nothing else about the production request", () => {
    // Endpoint and transport.
    expect(WORKER_CODE).toMatch(/const res = await fetch\(`\$\{NIM_BASE/);
    expect(WORKER_CODE).toMatch(/method: "POST",/);
    // Authorization shape, unchanged.
    expect(WORKER_CODE).toMatch(/authorization: `Bearer \$\{key\}`/);
    expect(WORKER_CODE).toMatch(/"content-type": "application\/json"/);
    // Generation parameters, unchanged.
    expect(WORKER_CODE).toMatch(/temperature: 0\.4,/);
    expect(WORKER_CODE).toMatch(/max_tokens: 4000,/);
    // Still non-streaming, and still under the Phase 6 deadline with abort.
    expect(WORKER_CODE).not.toMatch(/stream:\s*true/);
    expect(WORKER_CODE).toMatch(/withProviderDeadline\(timeoutMs, async \(signal\) => \{/);
    expect(WORKER_CODE).toMatch(/^\s+signal,$/m);
    expect(NIM_ARTICLE_DEFAULT_TIMEOUT_MS).toBe(90_000);
  });

  it("still fails closed when the provider rejects the request", () => {
    // Nothing here may weaken the failure path into a fabricated article.
    expect(WORKER_CODE).toMatch(/The article was not written\./);
    expect(WORKER_CODE).toMatch(/if \(!generated\.ok\) \{/);
    // The provider's JSON is still required to contain a real title and body.
    expect(WORKER_CODE).toMatch(/if \(!title \|\| !body\)/);
  });
});
