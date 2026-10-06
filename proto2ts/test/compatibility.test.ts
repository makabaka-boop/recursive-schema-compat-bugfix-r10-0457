/**
 * Compatibility-checker tests: the checker compares what the reader schema
 * does with the writer schema's bytes — fields match by number, packed is
 * irrelevant, nested messages are compared recursively from the chosen
 * entry points, recursion terminates, and reports are stable and shortest.
 * The CLI's exit status must mirror the report, and a failed check must
 * never clobber an existing report file.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkCompatibility } from "../src/compatibility.js";
import type { CompatIssue } from "../src/compatibility.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function issuesOf(
  writer: string,
  reader: string,
  writerRoot = "Root",
  readerRoot = "Root",
): CompatIssue[] {
  return checkCompatibility(writer, reader, writerRoot, readerRoot).issues;
}

function pathsOf(issues: CompatIssue[]): string[] {
  return issues.map((i) => `${i.issue}@${i.path.join(".")}`);
}

// ----- false positives: renames and packed toggles are compatible -----------

test("compat: renaming a field or a message is compatible", () => {
  const writer = `
message Inner { required int32 a = 1; }
message Root {
  required string name = 1;
  optional Inner inner = 2;
  repeated sint32 deltas = 3 [packed = true];
}`;
  const reader = `
message Renamed { required int32 a = 1; }
message Root {
  required string full_name = 1;
  optional Renamed inner = 2;
  repeated sint32 deltas = 3;
}`;
  assert.deepEqual(issuesOf(writer, reader), []);
  assert.deepEqual(issuesOf(reader, writer), []);
});

test("compat: toggling packed on a packable field is compatible", () => {
  const packed = `message Root { repeated int32 v = 1 [packed = true]; }`;
  const unpacked = `message Root { repeated int32 v = 1; }`;
  assert.deepEqual(issuesOf(packed, unpacked), []);
  assert.deepEqual(issuesOf(unpacked, packed), []);
});

// ----- false negatives: deep type / label / required-ness changes -----------

test("compat: type change deep in a submessage is reported with its path", () => {
  const writer = `
message Inner { required int32 a = 1; }
message Root { optional Inner inner = 2; }`;
  const reader = `
message Inner { required string a = 1; }
message Root { optional Inner inner = 2; }`;
  assert.deepEqual(issuesOf(writer, reader), [
    {
      path: [2, 1],
      issue: "type_changed",
      writer: "required int32 a",
      reader: "required string a",
    },
  ]);
});

test("compat: scalar-to-message and occurrence changes are reported", () => {
  const writer = `
message M { optional int32 x = 1; }
message Root {
  optional M a = 1;
  optional int32 b = 2;
  repeated int32 c = 3;
}`;
  const reader = `
message M { optional int32 x = 1; }
message Root {
  optional int32 a = 1;
  repeated int32 b = 2;
  optional int32 c = 3;
}`;
  assert.deepEqual(pathsOf(issuesOf(writer, reader)), [
    "type_changed@1",
    "label_changed@2",
    "label_changed@3",
  ]);
});

test("compat: required-ness changes are reported in both directions", () => {
  const req = `message Root { required int32 a = 1; }`;
  const opt = `message Root { optional int32 a = 1; }`;
  assert.deepEqual(pathsOf(issuesOf(req, opt)), ["label_changed@1"]);
  assert.deepEqual(pathsOf(issuesOf(opt, req)), ["label_changed@1"]);
});

test("compat: reader-required field the writer never sends is reported", () => {
  const writer = `message Root { optional int32 a = 1; }`;
  const optionalAdded = `message Root { optional int32 a = 1; optional string b = 2; }`;
  const requiredAdded = `message Root { optional int32 a = 1; required string b = 2; }`;
  assert.deepEqual(issuesOf(writer, optionalAdded), []);
  assert.deepEqual(issuesOf(writer, requiredAdded), [
    { path: [2], issue: "required_added", reader: "required string b" },
  ]);
});

test("compat: writer-only fields are preserved as unknown, not an issue", () => {
  const writer = `message Root { required int32 a = 1; optional string gone = 5; }`;
  const reader = `message Root { required int32 a = 1; }`;
  assert.deepEqual(issuesOf(writer, reader), []);
});

// ----- entry points, reachability, recursion, stability ---------------------

test("compat: declarations unrelated to the entry point are ignored", () => {
  const writer = `
message Unused { required int32 a = 1; }
message Old { optional Unused u = 1; optional Leaf leaf = 2; }
message Leaf { optional int32 x = 1; }`;
  const reader = `
message Unused { required string a = 1; }
message New { optional Leaf leaf = 2; }
message Leaf { optional int32 x = 1; }`;
  // Unused changed drastically, but no root-reachable pair touches it.
  assert.deepEqual(
    checkCompatibility(writer, reader, "Old", "New"),
    { compatible: true, issues: [] },
  );
});

test("compat: recursive references terminate and report once", () => {
  const writer = `message Chain { required int32 value = 1; optional Chain next = 2; }`;
  const reader = `message Chain {
  required int32 value = 1;
  optional Chain next = 2;
  required string tag = 3;
}`;
  const report = checkCompatibility(writer, reader, "Chain", "Chain");
  assert.deepEqual(pathsOf(report.issues), ["required_added@3"]);
  assert.equal(report.compatible, false);
});

test("compat: conflicts are reported at the shortest reachable path", () => {
  // (C, C) is reachable from the roots at depth 1 (field 1) and at depth 2
  // (field 2 -> field 1); the depth-1 path must win, and appear only once.
  const mk = (cx: string) => `
message Root { optional C c = 1; optional A a = 2; }
message A { optional C c = 1; }
message C { required ${cx} x = 1; }`;
  const issues = issuesOf(mk("int32"), mk("string"));
  assert.deepEqual(pathsOf(issues), ["type_changed@1.1"]);
});

test("compat: report order is stable regardless of declaration order", () => {
  const writer = `
message Root {
  optional string z = 9;
  optional int32 a = 1;
  optional int32 m = 5;
}`;
  const reader = `
message Root {
  optional int32 m = 5;
  required string z = 9;
  optional string a = 1;
}`;
  const issues = issuesOf(writer, reader);
  assert.deepEqual(pathsOf(issues), ["type_changed@1", "label_changed@9"]);
  // ... and identical across repeated runs.
  assert.deepEqual(issuesOf(writer, reader), issues);
});

// ----- invalid inputs --------------------------------------------------------

test("compat: unknown entry message fails with a clear error", () => {
  const schema = `message Root { optional int32 a = 1; }`;
  assert.throws(
    () => checkCompatibility(schema, schema, "Nope", "Root"),
    /writer root message 'Nope' not found \(declared: Root\)/,
  );
  assert.throws(
    () => checkCompatibility(schema, schema, "Root", "Nope"),
    /reader root message 'Nope' not found/,
  );
});

test("compat: unparseable schemas fail, naming the broken side", () => {
  const good = `message Root { optional int32 a = 1; }`;
  const bad = `message Root { optional int32 a = 1`;
  assert.throws(() => checkCompatibility(bad, good, "Root", "Root"), /writer schema: /);
  assert.throws(() => checkCompatibility(good, bad, "Root", "Root"), /reader schema: /);
});

// ----- the CLI: exit status mirrors the report; failures keep the report ----

function runCli(
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/compat-cli.ts", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const COMPATIBLE_A = `message Root { required int32 a = 1; }`;
const COMPATIBLE_B = `message Root { required int32 renamed = 1; optional string added = 2; }`;
const INCOMPATIBLE_B = `message Root { required string a = 1; }`;

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "proto2ts-compat-"));
  writeFileSync(join(dir, "a.proto"), COMPATIBLE_A);
  writeFileSync(join(dir, "b.proto"), COMPATIBLE_B);
  writeFileSync(join(dir, "broken.proto"), `message Root { required int32 a = 1`);
  return dir;
}

test("compat CLI: compatible pair exits 0 and writes a compatible report", () => {
  const dir = setup();
  const out = join(dir, "report.json");
  const r = runCli([join(dir, "a.proto"), join(dir, "b.proto"), "Root", "Root", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
    compatible: true,
    issues: [],
  });
});

test("compat CLI: incompatible pair exits 1 and the report says so too", () => {
  const dir = setup();
  writeFileSync(join(dir, "b.proto"), INCOMPATIBLE_B);
  const out = join(dir, "report.json");
  const r = runCli([join(dir, "a.proto"), join(dir, "b.proto"), "Root", "Root", out]);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.compatible, false);
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0].issue, "type_changed");
});

test("compat CLI: without -o the report goes to stdout", () => {
  const dir = setup();
  const r = runCli([join(dir, "a.proto"), join(dir, "b.proto"), "Root", "Root"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).compatible, true);
});

test("compat CLI: parse failure exits 2 and preserves an existing report", () => {
  const dir = setup();
  const out = join(dir, "report.json");
  writeFileSync(out, '{"previous":true}\n');
  const r = runCli([
    join(dir, "broken.proto"),
    join(dir, "b.proto"),
    "Root",
    "Root",
    out,
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /writer schema:/);
  assert.equal(readFileSync(out, "utf8"), '{"previous":true}\n');
});

test("compat CLI: unknown entry exits 2 and preserves an existing report", () => {
  const dir = setup();
  const out = join(dir, "report.json");
  writeFileSync(out, '{"previous":true}\n');
  const r = runCli([
    join(dir, "a.proto"),
    join(dir, "b.proto"),
    "Missing",
    "Root",
    out,
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /writer root message 'Missing' not found/);
  assert.equal(readFileSync(out, "utf8"), '{"previous":true}\n');
});

test("compat CLI: missing arguments are a usage error (exit 2)", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
