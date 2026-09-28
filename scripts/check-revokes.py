#!/usr/bin/env python3
"""Cross-check every `revoke ... on function X(sig)` in a migration against the
actual `create or replace function X(...)` parameter lists, AND verify each
revoke appears AFTER the function's definition (Postgres revokes on functions
require the target to exist; `create or replace` later in the file does not
satisfy an earlier revoke).

Prints MISMATCH (bad signature) and FORWARD-REF (revoke before definition)
lines; exit 1 if any.
Usage: python3 scripts/check-revokes.py supabase/migrations/<file>.sql
"""
import re
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()

# Strip comments but PRESERVE line structure so line numbers stay meaningful.
text_nc = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
lines_nc = [re.split(r"--", l, maxsplit=1)[0] for l in text_nc.splitlines()]
text_nc = "\n".join(lines_nc)

# Definitions: name + line of the `create function` keyword + signature types.
defs = {}
for m in re.finditer(
    r"create\s+(?:or\s+replace\s+)?function\s+public\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;]*?)\)\s*returns",
    text_nc,
    flags=re.I | re.S,
):
    name = m.group(1).lower()
    lineno = text_nc[: m.start()].count("\n") + 1
    raw = m.group(2)
    sig = []
    if raw.strip():
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            part = re.sub(r"\s+(default\s+[^,]+)\s*$", "", part, flags=re.I)
            part = re.sub(r"\s+(in|out|inout|variadic)\s+", " ", part, flags=re.I)
            toks = part.split()
            sig.append(toks[-1] if toks else "?")
    entry = {"sig": tuple(sig), "line": lineno}
    if name in defs:
        if not any(d["sig"] == entry["sig"] for d in defs[name]):
            defs[name].append(entry)
    else:
        defs[name] = [entry]

# Revokes with an explicit signature.
revokes = []
for m in re.finditer(
    r"revoke\s+all\s+on\s+function\s+public\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)",
    text_nc,
    flags=re.I,
):
    name = m.group(1).lower()
    lineno = text_nc[: m.start()].count("\n") + 1
    raw = m.group(2).strip()
    sig = tuple(t.strip().split()[-1] for t in raw.split(",") if t.strip())
    revokes.append((name, sig, lineno))

bad = 0
for name, sig, lineno in revokes:
    candidates = defs.get(name, [])
    if not any(c["sig"] == sig for c in candidates):
        print(f"MISMATCH {name}({','.join(sig)}) at line {lineno} -> defined as {[c['sig'] for c in candidates]}")
        bad += 1
        continue
    def_line = min(c["line"] for c in candidates if c["sig"] == sig)
    if def_line > lineno:
        print(f"FORWARD-REF revoke {name}({','.join(sig)}) at line {lineno} but definition is at line {def_line}")
        bad += 1

print(f"checked {len(revokes)} function revokes, {bad} problems")
sys.exit(1 if bad else 0)
