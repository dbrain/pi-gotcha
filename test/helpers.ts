import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GotchaStore, type GotchaDraft } from "../extensions/lib/store.ts";
import { DEFAULTS, type Settings } from "../extensions/lib/settings.ts";
import { createRuntime, type Runtime } from "../extensions/lib/runtime.ts";

export function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-gotcha-"));
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function settingsFor(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULTS,
    ...overrides,
    // No test may reach for a model or the network.
    embeddings: { ...DEFAULTS.embeddings, provider: "off", ...(overrides.embeddings ?? {}) },
  };
}

export function seededStore(root: string, drafts: GotchaDraft[]): GotchaStore {
  const store = new GotchaStore(root);
  for (const draft of drafts) store.add(draft);
  return store;
}

export function runtimeFor(root: string, overrides: Partial<Settings> = {}): Runtime {
  return createRuntime(root, settingsFor(overrides));
}

export const SAMPLE: GotchaDraft = {
  summary: "Invoice totals are integer cents; the CSV export drops any line containing a comma",
  expected: "The export to contain the formatted total 2,255.65 like every other column",
  actual: "The row vanished with no error; the finance parser treats a comma as corruption",
  paths: ["src/billing/", "src/export/csv.ts"],
  aliases: ["money formatting", "currency", "thousands separator"],
  body: "Invoice.total is an integer count of cents below the API boundary.",
};

export function idFromResult(text: string): string {
  return text.replace("Recorded ", "").split(".")[0].trim();
}
