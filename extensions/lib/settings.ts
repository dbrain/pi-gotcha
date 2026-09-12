import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingProvider = "auto" | "local" | "remote" | "off";

export interface Settings {
  surface: boolean;
  maxSurfacedPerTurn: number;
  standout: number;
  semanticFloor: number;
  searchVeto: number;
  sessionWriteCap: number;
  duplicateThreshold: number;
  embeddings: {
    provider: EmbeddingProvider;
    model: string;
    endpoint?: string;
    apiKey?: string;
  };
}

export const DEFAULTS: Settings = {
  surface: true,
  maxSurfacedPerTurn: 2,
  standout: 1.4,
  semanticFloor: 0.55,
  searchVeto: 0.15,
  sessionWriteCap: 3,
  duplicateThreshold: 0.55,
  embeddings: {
    provider: "auto",
    model: "Xenova/all-MiniLM-L6-v2",
  },
};

export function settingsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pi-gotcha", "settings.json");
}

function coerce(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (typeof source.surface === "boolean") out.surface = source.surface;
  if (Number.isFinite(source.maxSurfacedPerTurn)) out.maxSurfacedPerTurn = Number(source.maxSurfacedPerTurn);
  if (Number.isFinite(source.standout)) out.standout = Number(source.standout);
  if (Number.isFinite(source.semanticFloor)) out.semanticFloor = Number(source.semanticFloor);
  if (Number.isFinite(source.searchVeto)) out.searchVeto = Number(source.searchVeto);
  if (Number.isFinite(source.sessionWriteCap)) out.sessionWriteCap = Number(source.sessionWriteCap);
  if (Number.isFinite(source.duplicateThreshold)) out.duplicateThreshold = Number(source.duplicateThreshold);
  if (source.embeddings && typeof source.embeddings === "object") {
    const embeddings = source.embeddings as Record<string, unknown>;
    out.embeddings = { ...DEFAULTS.embeddings };
    if (typeof embeddings.provider === "string") {
      out.embeddings.provider = embeddings.provider as EmbeddingProvider;
    }
    if (typeof embeddings.model === "string") out.embeddings.model = embeddings.model;
    if (typeof embeddings.endpoint === "string") out.embeddings.endpoint = embeddings.endpoint;
    if (typeof embeddings.apiKey === "string") out.embeddings.apiKey = embeddings.apiKey;
  }
  return out;
}

export function loadSettings(path = settingsPath()): Settings {
  let fromFile: Partial<Settings> = {};
  if (existsSync(path)) {
    try {
      fromFile = coerce(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      fromFile = {};
    }
  }
  const merged: Settings = {
    ...DEFAULTS,
    ...fromFile,
    embeddings: { ...DEFAULTS.embeddings, ...(fromFile.embeddings ?? {}) },
  };
  const override = process.env.PI_GOTCHA_EMBEDDINGS;
  if (override === "local" || override === "remote" || override === "off" || override === "auto") {
    merged.embeddings.provider = override;
  }
  if (merged.standout < 1) merged.standout = 1;
  if (merged.maxSurfacedPerTurn < 0) merged.maxSurfacedPerTurn = 0;
  return merged;
}
