// ---------------------------------------------------------------------------
// Edge Function integrity guard (ratchet)
//
// WHY THIS EXISTS
//
// `tsconfig.app.json` includes only `src`, and `tsconfig.node.json` only
// `vite.config.ts`, so **nothing under `supabase/functions/` is compiled by
// `bunx tsc -b --noEmit`**. A truncated, renamed or mis-imported Edge Function
// source therefore passes the whole CI gate and only fails at deploy (or, worse,
// at request time). This branch was opened to repair exactly that class of
// defect, so the gap is real and was not closed by the type checker.
//
// WHAT IT CHECKS (all static, no Deno, no network, no database)
//
//   1. Every `[functions.<name>]` block in supabase/config.toml has a real
//      `supabase/functions/<name>/index.ts` entry point.
//   2. Every `.ts` file under supabase/functions parses as TypeScript — a
//      truncated file (the failure mode this branch exists for) is a syntax
//      error and fails here.
//   3. Every relative import resolves to a file that exists — catches a shared
//      module that was moved, renamed or lost.
//   4. Every function deployed with `verify_jwt = false` verifies its own
//      signature in code. These functions bypass Supabase JWT verification
//      entirely, so an unsigned deploy is an unauthenticated write endpoint;
//      the config comment promises verification and this pins it.
//
// WHAT IT DOES NOT CHECK (stated so the gate is never read as more than it is)
//
//   - Semantic type errors. That needs a real type-checker with Deno's globals
//     and remote module resolution; Deno is not installed in this workspace, so
//     `supabase/functions/**` remains UNVERIFIED by `tsc` (reported, not hidden).
//   - Runtime behaviour of an entry point. Entry points call `Deno.serve` and
//     import `https://` / `jsr:` specifiers, so they cannot be executed here.
//     The *pure* shared modules ARE executed — see
//     `src/lib/integrations/primitives.parity.test.ts` and
//     `supabase/functions/_shared/stripe-subscription-merge.test.ts`.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const FUNCTIONS = resolve(ROOT, "supabase/functions");
const CONFIG = resolve(ROOT, "supabase/config.toml");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Every `.ts` file under supabase/functions, as paths relative to it. */
function functionSources(): string[] {
  return walk(FUNCTIONS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(FUNCTIONS.length + 1))
    .sort();
}

function readFunction(rel: string): string {
  return readFileSync(resolve(FUNCTIONS, rel), "utf8");
}

/** Remove `// line comments` so a commented-out call is not treated as live. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * `[functions.<name>]` blocks from supabase/config.toml, keyed by function name
 * with the block body as the value.
 */
function functionBlocks(): Map<string, string> {
  const lines = readFileSync(CONFIG, "utf8").split("\n");
  const blocks = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current) blocks.set(current, buf.join("\n"));
  };

  for (const line of lines) {
    const header = line.match(/^\[([A-Za-z0-9_.-]+)\]\s*$/);
    if (header) {
      flush();
      const name = header[1];
      current = name.startsWith("functions.") ? name.slice("functions.".length) : null;
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return blocks;
}

function relativeSpecifiers(src: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import/export ... from "..."
    /\bimport\s+["']([^"']+)["']/g, // side-effect import "..."
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("...")
  ];
  for (const pattern of patterns) {
    for (const m of src.matchAll(pattern)) {
      if (m[1].startsWith(".")) specs.add(m[1]);
    }
  }
  return [...specs];
}

const SOURCES = functionSources();
const BLOCKS = functionBlocks();

describe("edge function integrity (ratchet)", () => {
  it("has an entry point for every function declared in supabase/config.toml", () => {
    expect(BLOCKS.size).toBeGreaterThan(0);
    const missing = [...BLOCKS.keys()].filter(
      (name) => !existsSync(resolve(FUNCTIONS, name, "index.ts")),
    );
    expect(missing).toEqual([]);
  });

  // A no-op syntax check would pass forever, so prove it can fail first.
  it("detects a syntax error when one is present (self-check)", () => {
    const broken = ts.transpileModule("export function f( { return 1;", {
      reportDiagnostics: true,
      fileName: "broken.ts",
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    expect(
      (broken.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).length,
    ).toBeGreaterThan(0);
  });

  it("parses every edge function source without syntax errors", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const rel of SOURCES) {
      const result = ts.transpileModule(readFunction(rel), {
        reportDiagnostics: true,
        fileName: rel,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      for (const d of result.diagnostics ?? []) {
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
        failures.push(`${rel}: ${message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("resolves every relative import inside supabase/functions", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
    const unresolved: string[] = [];
    let scanned = 0;
    for (const rel of SOURCES) {
      const base = dirname(resolve(FUNCTIONS, rel));
      for (const spec of relativeSpecifiers(readFunction(rel))) {
        scanned += 1;
        const target = resolve(base, spec);
        const candidates = [target, `${target}.ts`, join(target, "index.ts"), `${target}.tsx`];
        if (!candidates.some((c) => existsSync(c))) {
          unresolved.push(`${rel} -> ${spec}`);
        }
      }
    }
    // Anti-vacuity: if the scanner ever stops matching (a regex/refactor
    // regression) the loop above would silently check nothing and pass.
    expect(scanned).toBeGreaterThan(20);
    expect(unresolved).toEqual([]);
  });

  it("verifies its own signature in every function deployed with verify_jwt = false", () => {
    // Derived from supabase/config.toml, so adding a JWT-exempt function
    // automatically brings it under this rule instead of silently escaping it.
    const exempt = [...BLOCKS.entries()]
      .filter(([, body]) => /^\s*verify_jwt\s*=\s*false\s*$/m.test(body))
      .map(([name]) => name);

    expect(exempt.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of exempt) {
      const rel = `${name}/index.ts`;
      if (!existsSync(resolve(FUNCTIONS, rel))) {
        offenders.push(`${rel}: entry point missing`);
        continue;
      }
      const code = stripComments(readFunction(rel));
      // A Stripe-style or generic HMAC signature verification must be present.
      const verifies =
        /verifyStripeWebhookSignature\s*\(/.test(code) || /verifyWebhookSignature\s*\(/.test(code);
      if (!verifies) {
        offenders.push(
          `${rel}: verify_jwt = false but no signature verification call found — ` +
            `this function would accept unauthenticated requests`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
