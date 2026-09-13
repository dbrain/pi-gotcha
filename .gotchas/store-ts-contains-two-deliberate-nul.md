---
summary: store.ts contains two deliberate NUL bytes (hash field separators), so
  grep treats it as binary and prints no matches — use grep -a
paths:
  - extensions/lib/store.ts
aliases:
  - binary file matches
  - grep on store.ts
  - file says data
  - store.ts empty grep output
expected: grep on extensions/lib/store.ts to print matching lines like any other
  source file
actual: grep refuses with "binary file matches" and prints no lines at all,
  making it look like the searched symbol is missing from the file; `file`
  reports the file as "data". The cause is two deliberate NUL bytes used as
  field separators in the hashOf template literal — not corruption (a byte scan
  confirms exactly 2 NULs, zero non-ASCII, and all tests pass)
trigger: grepping extensions/lib/store.ts and getting "binary file matches" or
  empty output, or suspecting the file is corrupted
created: 2026-09-13
updated: 2026-09-13
---

store.ts line ~59 (hashOf) uses real NUL bytes as field separators in the content hash: `${summary}\x00${aliases.join(",")}\x00${body}`. The two NULs are deliberate (they prevent field-boundary collisions like "ab|c" vs "a|bc"), and Node parses the file fine — but `grep` classifies the file as binary and prints "grep: extensions/lib/store.ts: binary file matches" with NO line output, and `file` reports "data". Symptoms that waste time: grep for list()/retire() etc. returns nothing and looks like the symbol is absent. Use `grep -a` or node to inspect. Verified 2026-09-13: exactly 2 NUL bytes, both on the hashOf line, zero non-ASCII.
