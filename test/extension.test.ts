import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import register from "../extensions/index.ts";
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

function project(withGotcha = true): { root: string; ctx: any } {
  const root = tempRoot();
  roots.push(root);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  writeFileSync(join(root, "src", "billing", "invoice.ts"), "");
  if (withGotcha) {
    const store = new GotchaStore(root);
    store.add({
      summary: "Invoice totals are integer cents; the CSV export drops any line with a comma",
      evidence: "Expected 2,255.65 in the export and the row vanished with no error",
      paths: ["src/billing/"],
      aliases: ["money", "currency"],
      body: "Detail.",
    });
    store.add({
      summary: "Deploys must run migrations twice; the first pass only creates the enum",
      evidence: "Staging deploy failed until the migration was run a second time by hand",
      paths: [],
      aliases: ["migration", "deploy"],
      body: "Detail.",
    });
  }
  return { root, ctx: { cwd: root, ui: { notify: () => {}, confirm: async () => true } } };
}

after(() => roots.forEach(cleanup));

describe("extension wiring", () => {
  test("registers the tool and the commands", () => {
    const pi = fakePi();
    register(pi as any);
    assert.ok(pi.tools.has("gotcha"));
    assert.deepEqual(
      [...pi.commands.keys()].sort(),
      ["gotchas", "gotchas-apply", "gotchas-audit", "gotchas-review"],
    );
  });

  test("touching a covered file delivers its line once the turn settles", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("session_start", {}, ctx);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    assert.deepEqual(pi.sent, []);

    await pi.emit("agent_settled", {}, ctx);
    assert.equal(pi.sent.length, 1);
    assert.match(pi.sent[0], /^\[gotcha\] src\/billing\/ — Invoice totals are integer cents/);
  });

  test("the same gotcha is not delivered twice in a session", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
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

  test("touching an uncovered file delivers nothing", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "notes.md"), "");
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "docs/notes.md" } }, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });

  test("a project with no store stays silent", async () => {
    const pi = fakePi();
    const { ctx } = project(false);
    register(pi as any);
    await pi.emit("session_start", {}, ctx);
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

  test("the tool executes through pi's interface", async () => {
    const pi = fakePi();
    const { ctx } = project();
    register(pi as any);
    const tool = pi.tools.get("gotcha");
    const result = await tool.execute("call-1", { action: "list" }, null, null, ctx);
    assert.match(result.content[0].text, /Invoice totals/);
  });

  test("reading through the tool withdraws the staged line", async () => {
    const pi = fakePi();
    const { ctx, root } = project();
    const id = new GotchaStore(root).list().find((g) => g.paths.length)!.id;
    register(pi as any);
    await pi.emit("tool_call", { toolName: "read", input: { path: "src/billing/invoice.ts" } }, ctx);
    await pi.tools.get("gotcha").execute("call-1", { action: "read", id }, null, null, ctx);
    await pi.emit("agent_settled", {}, ctx);
    assert.deepEqual(pi.sent, []);
  });
});
