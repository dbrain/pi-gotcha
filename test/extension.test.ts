import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import register from "../extensions/index.ts";
import { Ledger } from "../extensions/lib/ledger.ts";
import { GotchaStore } from "../extensions/lib/store.ts";
import { cleanup, tempRoot } from "./helpers.ts";

const roots: string[] = [];

interface FakePi {
  handlers: Map<string, Function[]>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  sent: string[];
  emit(event: string, payload: unknown, ctx: unknown): Promise<void>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    handlers,
    tools: new Map(),
    commands: new Map(),
    sent: [] as string[],
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(definition: any) {
      pi.tools.set(definition.name, definition);
    },
    registerCommand(name: string, definition: any) {
      pi.commands.set(name, definition);
    },
    sendMessage(message: any) {
      pi.sent.push(message.content);
    },
    async emit(event: string, payload: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
  return pi as FakePi;
}

const BILLING = {
  summary: "Invoice totals are integer cents; the CSV export drops any line with a comma",
  expected: "The export to contain the formatted total like every other column",
  actual: "The row vanished with no error at all, silently, in the finance parser",
  paths: ["src/billing/"],
  aliases: ["money", "currency"],
  body: "Detail.",
};

const MIGRATIONS = {
  summary: "Deploys must run migrations twice; the first pass only creates the enum",
  expected: "One migration pass to bring staging up to date, as in every other environment",
  actual: "The deploy failed until the migration was run a second time by hand",
  paths: [],
  aliases: ["migration", "deploy"],
  body: "Detail.",
};

function project(seed = true): { root: string; ctx: any; store: GotchaStore } {
  const root = tempRoot();
  roots.push(root);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  writeFileSync(join(root, "src", "billing", "invoice.ts"), "");
  const store = new GotchaStore(root);
  if (seed) {
    store.add(BILLING);
    store.add(MIGRATIONS);
  }
  // Keep every test off the network and away from a model.
  mkdirSync(join(root, ".gotchas"), { recursive: true });
  writeFileSync(join(root, ".gotchas", "settings.json"), JSON.stringify({ embeddings: { provider: "off" } }));
  return { root, ctx: { cwd: root, ui: { notify: () => {}, confirm: async () => true } }, store };
}

after(() => roots.forEach(cleanup));

describe("extension wiring", () => {
  test("registers the tool and the commands", () => {
    const pi = fakePi();
    register(pi as any);
    assert.ok(pi.tools.has("gotcha"));
    assert.deepEqual(
      [...pi.commands.keys()].sort(),
      [
        "gotchas",
        "gotchas-apply",
        "gotchas-audit",
        "gotchas-budget",
        "gotchas-index",
        "gotchas-proposals",
        "gotchas-review",
      ],
    );
  });

  test("touching a covered file delivers its line once the turn settles", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    assert.deepEqual(pi.sent, []);

    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.sent.length, 1);
    assert.match(pi.sent[0], /^\[gotcha\] src\/billing\/ — Invoice totals are integer cents/);
  });

  test("delivering a line counts as surfaced", async () => {
    const pi = fakePi();
    const { ctx, store } = project();
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    const id = store.list().find((g) => g.paths.length)!.id;
    assert.equal(new Ledger(store).usage(id).surfaced, 1);
  });

  test("the path channel is capped per turn", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    const store = new GotchaStore(root);
    for (let i = 0; i < 5; i += 1) {
      store.add({ ...BILLING, summary: `Billing quirk number ${i} that surprises everyone who meets it` });
    }
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.sent[0].split("\n").length, 3);
  });

  test("the same gotcha is not delivered twice in a session", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    for (let i = 0; i < 2; i += 1) {
      await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
      await pi.emit("agent_settled", {}, ctx);
    }
    assert.equal(pi.sent.length, 1);
  });

  test("compaction lets it surface again", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    await pi.emit("session_compact", {}, ctx);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.sent.length, 2);
  });

  test("a file body mentioning a covered path delivers nothing", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "notes.md"), "");
    register(pi as any);
    const content = `${"filler line\n".repeat(80)}see src/billing/invoice.ts for details\n`;
    await pi.emit("tool_call", { toolName: "write", input: { path: "docs/notes.md", content } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });

  test("a project with no store stays silent", async () => {
    const pi = fakePi();
    const { ctx } = project(false);
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("before_agent_start", { prompt: "anything at all" }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });

  test("a prompt about project-wide knowledge surfaces it", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("before_agent_start", { prompt: "the staging deploy failed on migrations again" }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.sent.length, 1);
    assert.match(pi.sent[0], /migrations twice/);
  });

  test("an unrelated prompt surfaces nothing", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("before_agent_start", { prompt: "rename the button label on the settings screen" }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });

  test("a project can turn surfacing off", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    writeFileSync(
      join(root, ".gotchas", "settings.json"),
      JSON.stringify({ surface: false, embeddings: { provider: "off" } }),
    );
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });

  test("the index command writes a browsable map", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    register(pi as any);
    await pi.commands.get("gotchas-index").handler("", ctx);
    const index = readFileSync(join(root, ".gotchas", ".cache", "index.md"), "utf8");
    assert.match(index, /## src\/billing\//);
    assert.match(index, /## project-wide/);
  });

  test("the tool executes through pi's interface", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    const result = await pi.tools.get("gotcha").execute("call-1", { action: "list" }, null, null, ctx);
    assert.match(result.content[0].text, /Invoice totals/);
  });

  test("reading through the tool withdraws the staged line", async () => {
    const pi = fakePi();
    const { ctx, store } = project();
    const id = store.list().find((g) => g.paths.length)!.id;
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.tools.get("gotcha").execute("call-1", { action: "read", id }, null, null, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });
});
