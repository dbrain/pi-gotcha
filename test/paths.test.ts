import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { covers, isRepoWide, matching, pathsIn, projectWide, specificity, staleScopes } from "../extensions/lib/paths.ts";
import type { Gotcha } from "../extensions/lib/store.ts";
import { cleanup, tempRoot } from "./helpers.ts";

const roots: string[] = [];
function project(): string {
  const root = tempRoot();
  roots.push(root);
  mkdirSync(join(root, "src", "billing"), { recursive: true });
  mkdirSync(join(root, "src", "export"), { recursive: true });
  writeFileSync(join(root, "src", "billing", "invoice.ts"), "");
  writeFileSync(join(root, "src", "export", "csv.ts"), "");
  return root;
}

after(() => roots.forEach(cleanup));

describe("covers", () => {
  const cases: Array<[string, string, boolean]> = [
    ["src/billing/", "src/billing/invoice.ts", true],
    ["src/billing", "src/billing/invoice.ts", true],
    ["src/billing/invoice.ts", "src/billing/invoice.ts", true],
    ["src/bill", "src/billing/invoice.ts", false],
    ["src/billing/", "src/export/csv.ts", false],
    ["./src/billing/", "src/billing/invoice.ts", true],
    ["", "src/billing/invoice.ts", false],
    [".", "src/billing/invoice.ts", false],
    ["/", "src/billing/invoice.ts", false],
  ];
  for (const [scope, touched, expected] of cases) {
    test(`${scope || "(empty)"} vs ${touched}`, () => assert.equal(covers(scope, touched), expected));
  }
});

describe("isRepoWide", () => {
  for (const scope of ["", ".", "./", "/", " . "]) {
    test(`${JSON.stringify(scope)} is repo-wide`, () => assert.equal(isRepoWide(scope), true));
  }
  for (const scope of ["src/", "src/billing", "a/b/c.ts"]) {
    test(`${scope} is not repo-wide`, () => assert.equal(isRepoWide(scope), false));
  }
});

describe("pathsIn", () => {
  test("finds a path in a plain string parameter", () => {
    const root = project();
    assert.deepEqual(pathsIn({ path: "src/billing/invoice.ts" }, root), ["src/billing/invoice.ts"]);
  });

  test("finds paths nested in objects and arrays", () => {
    const root = project();
    const found = pathsIn({ edits: [{ file: "src/billing/invoice.ts" }, { file: "src/export/csv.ts" }] }, root);
    assert.deepEqual(found.sort(), ["src/billing/invoice.ts", "src/export/csv.ts"]);
  });

  test("finds a path inside a bash command string", () => {
    const root = project();
    assert.deepEqual(pathsIn({ command: "grep -n total src/billing/invoice.ts" }, root), ["src/billing/invoice.ts"]);
  });

  test("absolute paths are normalized to repo-relative", () => {
    const root = project();
    assert.deepEqual(pathsIn({ path: join(root, "src/billing/invoice.ts") }, root), ["src/billing/invoice.ts"]);
  });

  test("a file that does not exist yet is found via its parent directory", () => {
    const root = project();
    assert.deepEqual(pathsIn({ path: "src/billing/refund.ts" }, root), ["src/billing/refund.ts"]);
  });

  test("paths outside the project are ignored", () => {
    const root = project();
    assert.deepEqual(pathsIn({ path: "/etc/passwd" }, root), []);
  });

  test("a file body that merely mentions a path is not a touch", () => {
    const root = project();
    const content = `${"// filler comment line\n".repeat(60)}import x from "src/billing/invoice.ts";\n`;
    assert.ok(content.length > 512);
    assert.deepEqual(pathsIn({ path: "src/export/csv.ts", content }, root), ["src/export/csv.ts"]);
  });

  test("a long command is still scanned, at the head where its arguments are", () => {
    const root = project();
    const command = `grep -n total src/billing/invoice.ts ${"# padding".repeat(200)}`;
    assert.ok(command.length > 512);
    assert.deepEqual(pathsIn({ command }, root), ["src/billing/invoice.ts"]);
  });

  test("known limit: a new file at the project root is invisible until it exists", () => {
    const root = project();
    assert.deepEqual(pathsIn({ path: "NOTES.md" }, root), []);
  });

  test("known limit: a path built from a shell variable is missed", () => {
    const root = project();
    assert.deepEqual(pathsIn({ command: 'cat "$DIR/invoice.ts"' }, root), []);
  });
});

function gotcha(id: string, paths: string[]): Gotcha {
  return {
    id,
    summary: `${id} summary`,
    paths,
    aliases: [],
    expected: "",
    actual: "",
    body: "",
    created: "2026-01-01",
    updated: "2026-01-01",
    file: `${id}.md`,
    hash: id,
  };
}

describe("matching", () => {
  const store = [
    gotcha("billing", ["src/billing/"]),
    gotcha("csv", ["src/export/csv.ts"]),
    gotcha("wide", []),
    gotcha("repo", ["."]),
  ];

  test("directory scope matches a file inside it", () => {
    assert.deepEqual(matching(store, ["src/billing/invoice.ts"]).map((g) => g.id), ["billing"]);
  });

  test("file scope matches only that file", () => {
    assert.deepEqual(matching(store, ["src/export/csv.ts"]).map((g) => g.id), ["csv"]);
  });

  test("pathless and repo-wide gotchas never match by path", () => {
    assert.deepEqual(matching(store, ["src/billing/invoice.ts", "src/export/csv.ts"]).map((g) => g.id), [
      "csv",
      "billing",
    ]);
  });

  test("no touched paths means no matches", () => {
    assert.deepEqual(matching(store, []), []);
  });

  test("the most specific scope wins when the cap bites", () => {
    const nested = [gotcha("broad", ["src/"]), gotcha("narrow", ["src/billing/invoice.ts"])];
    assert.deepEqual(matching(nested, ["src/billing/invoice.ts"], 1).map((g) => g.id), ["narrow"]);
  });

  test("a cap of zero surfaces nothing", () => {
    assert.deepEqual(matching(store, ["src/billing/invoice.ts"], 0), []);
  });

  test("specificity counts scope depth", () => {
    assert.equal(specificity(gotcha("a", ["src/"]), ["src/billing/invoice.ts"]), 1);
    assert.equal(specificity(gotcha("b", ["src/billing/"]), ["src/billing/invoice.ts"]), 2);
    assert.equal(specificity(gotcha("c", ["docs/"]), ["src/billing/invoice.ts"]), 0);
  });

  test("projectWide takes the pathless and the repo-wide", () => {
    assert.deepEqual(projectWide(store).map((g) => g.id), ["wide", "repo"]);
  });
});

describe("staleScopes", () => {
  test("flags scopes that no longer exist", () => {
    const root = project();
    const entry = gotcha("mixed", ["src/billing/", "src/gone/", "src/export/csv.ts"]);
    assert.deepEqual(staleScopes(entry, root), ["src/gone/"]);
  });

  test("a repo-wide scope is never stale", () => {
    assert.deepEqual(staleScopes(gotcha("repo", ["."]), project()), []);
  });
});
