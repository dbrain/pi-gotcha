import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Gotcha } from "./store.ts";

const PATHLIKE = /([\w.\-/@]+\/[\w.\-/@]+)/g;
const MAX_SCANNED = 512;

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

export function pathsIn(input: unknown, root: string): string[] {
  const found = new Set<string>();
  const consider = (candidate: string) => {
    const rel = toRelative(root, candidate.trim());
    if (rel) found.add(rel);
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const whole = value.trim();
      if (whole && whole.length < MAX_SCANNED && !whole.includes("\n")) consider(whole);
      for (const match of value.matchAll(PATHLIKE)) consider(match[1]);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(input);
  return [...found];
}

export function covers(scope: string, touched: string): boolean {
  const clean = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean) return false;
  if (clean === touched) return true;
  const asDir = clean.endsWith("/") ? clean : `${clean}/`;
  return touched.startsWith(asDir);
}

export function matching(gotchas: Gotcha[], touched: string[]): Gotcha[] {
  if (!touched.length) return [];
  return gotchas.filter((gotcha) => gotcha.paths.some((scope) => touched.some((path) => covers(scope, path))));
}

export function projectWide(gotchas: Gotcha[]): Gotcha[] {
  return gotchas.filter((gotcha) => gotcha.paths.length === 0);
}

export function staleScopes(gotcha: Gotcha, root: string): string[] {
  return gotcha.paths.filter((scope) => {
    const clean = scope.replace(/\/$/, "");
    return !existsSync(join(root, clean));
  });
}
