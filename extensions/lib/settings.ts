import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingProvider = "auto" | "local" | "remote" | "off";

export interface Settings {
  surface: boolean;
  overBudgetPrompt: boolean;
  maxSurfacedPerTurn: number;
  maxPathSurfacedPerTurn: number;
  standout: number;
  semanticFloor: number;
  searchVeto: number;
  dailyWriteCap: number;
  duplicateThreshold: number;
  duplicateOverlap: number;
  minEvidence: number;
  requireAliases: number;
  listLimit: number;
  embeddings: {
    provider: EmbeddingProvider;
    model: string;
    endpoint?: string;
    apiKey?: string;
  };
}

export const DEFAULTS: Settings = {
  surface: true,
  overBudgetPrompt: true,
  maxSurfacedPerTurn: 2,
  maxPathSurfacedPerTurn: 3,
  standout: 1.4,
  semanticFloor: 0.55,
  searchVeto: 0.15,
  dailyWriteCap: 5,
  duplicateThreshold: 0.55,
  duplicateOverlap: 0.35,
  minEvidence: 15,
  requireAliases: 2,
  listLimit: 30,
  embeddings: {
    provider: "auto",
    model: "Xenova/all-MiniLM-L6-v2",
  },
};

const NUMERIC: Array<keyof Settings> = [
  "maxSurfacedPerTurn",
  "maxPathSurfacedPerTurn",
  "standout",
  "semanticFloor",
  "searchVeto",
  "dailyWriteCap",
  "duplicateThreshold",
  "duplicateOverlap",
  "minEvidence",
  "requireAliases",
  "listLimit",
];

export function settingsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pi-gotcha", "settings.json");
}

export function projectSettingsPath(root: string): string {
  return join(root, ".gotchas", "settings.json");
}

function coerce(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source.surface === "boolean") out.surface = source.surface;
  if (typeof source.overBudgetPrompt === "boolean") out.overBudgetPrompt = source.overBudgetPrompt;
  for (const key of NUMERIC) if (Number.isFinite(source[key])) out[key] = Number(source[key]);
  if (source.embeddings && typeof source.embeddings === "object") {
    const embeddings = source.embeddings as Record<string, unknown>;
    const merged: Settings["embeddings"] = { ...DEFAULTS.embeddings };
    if (typeof embeddings.provider === "string") merged.provider = embeddings.provider as EmbeddingProvider;
    if (typeof embeddings.model === "string") merged.model = embeddings.model;
    if (typeof embeddings.endpoint === "string") merged.endpoint = embeddings.endpoint;
    if (typeof embeddings.apiKey === "string") merged.apiKey = embeddings.apiKey;
    out.embeddings = merged;
  }
  return out as Partial<Settings>;
}

function read(path: string): Partial<Settings> {
  if (!existsSync(path)) return {};
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

// Project settings win over user settings, which win over defaults; the environment
// variable overrides the embedding provider everywhere, for a quick local override.
export function loadSettings(root?: string, userPath = settingsPath()): Settings {
  const user = read(userPath);
  const project = root ? read(projectSettingsPath(root)) : {};
  const merged: Settings = {
    ...DEFAULTS,
    ...user,
    ...project,
    embeddings: { ...DEFAULTS.embeddings, ...(user.embeddings ?? {}), ...(project.embeddings ?? {}) },
  };

  const override = process.env.PI_GOTCHA_EMBEDDINGS;
  if (override === "local" || override === "remote" || override === "off" || override === "auto") {
    merged.embeddings.provider = override;
  }

  if (merged.standout < 1) merged.standout = 1;
  for (const key of ["maxSurfacedPerTurn", "maxPathSurfacedPerTurn", "dailyWriteCap", "listLimit"] as const) {
    if (merged[key] < 0) merged[key] = 0;
  }
  return merged;
}
