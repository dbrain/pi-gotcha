import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULTS, loadSettings, projectSettingsPath } from "../extensions/lib/settings.ts";
import { cleanup, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function project(settings?: unknown): string {
  const root = tempRoot();
  roots.push(root);
  if (settings !== undefined) {
    mkdirSync(join(root, ".gotchas"), { recursive: true });
    writeFileSync(projectSettingsPath(root), JSON.stringify(settings));
  }
  return root;
}

function userFile(settings: unknown): string {
  const root = tempRoot();
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

after(() => {
  roots.forEach(cleanup);
  delete process.env.PI_GOTCHA_EMBEDDINGS;
});

describe("loadSettings", () => {
  test("defaults when nothing is configured", () => {
    const settings = loadSettings(project(), join(project(), "missing.json"));
    assert.equal(settings.maxPathSurfacedPerTurn, DEFAULTS.maxPathSurfacedPerTurn);
    assert.equal(settings.dailyWriteCap, DEFAULTS.dailyWriteCap);
  });

  test("user settings override defaults", () => {
    const settings = loadSettings(project(), userFile({ dailyWriteCap: 9 }));
    assert.equal(settings.dailyWriteCap, 9);
  });

  test("project settings override user settings", () => {
    const settings = loadSettings(project({ dailyWriteCap: 1 }), userFile({ dailyWriteCap: 9 }));
    assert.equal(settings.dailyWriteCap, 1);
  });

  test("a project can turn surfacing off in one repo", () => {
    assert.equal(loadSettings(project({ surface: false })).surface, false);
  });

  test("embedding settings merge rather than replace wholesale", () => {
    const settings = loadSettings(project({ embeddings: { provider: "off" } }), userFile({}));
    assert.equal(settings.embeddings.provider, "off");
    assert.equal(settings.embeddings.model, DEFAULTS.embeddings.model);
  });

  test("the environment variable wins over both files", () => {
    process.env.PI_GOTCHA_EMBEDDINGS = "off";
    const settings = loadSettings(project({ embeddings: { provider: "local" } }));
    assert.equal(settings.embeddings.provider, "off");
    delete process.env.PI_GOTCHA_EMBEDDINGS;
  });

  test("malformed json falls back to defaults instead of throwing", () => {
    const root = tempRoot();
    roots.push(root);
    mkdirSync(join(root, ".gotchas"), { recursive: true });
    writeFileSync(projectSettingsPath(root), "{ nope");
    assert.equal(loadSettings(root).dailyWriteCap, DEFAULTS.dailyWriteCap);
  });

  test("nonsense values are clamped", () => {
    const settings = loadSettings(project({ standout: 0.2, maxSurfacedPerTurn: -4 }));
    assert.equal(settings.standout, 1);
    assert.equal(settings.maxSurfacedPerTurn, 0);
  });
});
