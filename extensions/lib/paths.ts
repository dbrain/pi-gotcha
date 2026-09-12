import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Gotcha } from "./store.ts";

const PATHLIKE = /([\w.\-/@]+\/[\w.\-/@]+)/g;
const MAX_WHOLE = 512;
const MAX_SCANNED = 2048;
const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filename",
  "filepath",
  "dir",
  "directory",
  "cwd",
  "command",
  "cmd",
  "args",
  "pattern",
  "glob",
  "target",
  "source",
  "destination",
]);

function toRelative(root: string, candidate: string): string | null {
  const normalized = candidate.replace(/\\/g, "/");
  const absolute = isAbsolute(normalized) ? normalized : join(root, normalized);
  // A path whose parent exists but which doesn't yet counts: a file about to be created
  // should still surface what governs its directory.
  if (!existsSync(absolute) && !(normalized.includes("/") && existsSync(dirname(absolute)))) return null;
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

/* Only a tool call's addressing is scanned, never its payload. An edit or write carries the
   whole file body, and a path mentioned in an import or a comment is not a claim of
   attention: treating it as one surfaced gotchas for files the turn never touched. Long
   strings are therefore scanned only under a key that names a location, and only at the
   head, which is where a command puts its arguments. */
export function pathsIn(input: unknown, root: string): string[] {
  const found = new Set<string>();
  const consider = (candidate: string) => {
    const rel = toRelative(root, candidate.trim());
    if (rel) found.add(rel);
  };

  const scan = (value: string, key: string): void => {
    const whole = value.trim();
    if (whole && whole.length < MAX_WHOLE && !whole.includes("\n")) consider(whole);
    if (value.length <= MAX_WHOLE) {
      for (const match of value.matchAll(PATHLIKE)) consider(match[1]);
      return;
    }
    if (!PATH_KEYS.has(key)) return;
    for (const match of value.slice(0, MAX_SCANNED).matchAll(PATHLIKE)) consider(match[1]);
  };

  const walk = (value: unknown, key: string): void => {
    if (typeof value === "string") scan(value, key);
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry, key));
    else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    }
  };

  walk(input, "");
  return [...found];
}

export function isRepoWide(scope: string): boolean {
  const clean = scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return clean === "" || clean === "." || clean === "/";
}

export function covers(scope: string, touched: string): boolean {
  const clean = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || isRepoWide(scope)) return false;
  if (clean === touched) return true;
  const asDir = clean.endsWith("/") ? clean : `${clean}/`;
  return touched.startsWith(asDir);
}

export function specificity(gotcha: Gotcha, touched: string[]): number {
  let best = 0;
  for (const scope of gotcha.paths) {
    if (!touched.some((path) => covers(scope, path))) continue;
    const depth = scope.replace(/\/+$/, "").split("/").length;
    if (depth > best) best = depth;
  }
  return best;
}

/* Deepest scope first: a gotcha about this file beats one about its package, so a cap keeps
   the specific and drops the general rather than whichever happened to be read first. */
export function matching(gotchas: Gotcha[], touched: string[], limit = Infinity): Gotcha[] {
  if (!touched.length || limit <= 0) return [];
  return gotchas
    .filter((gotcha) => gotcha.paths.some((scope) => touched.some((path) => covers(scope, path))))
    .sort((a, b) => specificity(b, touched) - specificity(a, touched))
    .slice(0, limit);
}

// Knowledge with no path, or scoped at the repo root, is reached by relevance rather than by
// touch: scoping something at the root would otherwise surface it on every call of the day.
export function projectWide(gotchas: Gotcha[]): Gotcha[] {
  return gotchas.filter((gotcha) => gotcha.paths.length === 0 || gotcha.paths.some(isRepoWide));
}

export function staleScopes(gotcha: Gotcha, root: string): string[] {
  return gotcha.paths.filter((scope) => {
    if (isRepoWide(scope)) return false;
    const clean = scope.replace(/\/$/, "");
    return !existsSync(join(root, clean));
  });
}
