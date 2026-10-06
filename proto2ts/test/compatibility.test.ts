/**
 * Compatibility review tests: the one-direction "can everything written by
 * the writer schema be read by the reader schema" check, driven from actual
 * .proto text.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCompatibility } from "../src/compatibility.js";
import { CompileError } from "../src/compiler/index.js";

function review(
  writer: string,
  reader: string,
  writerRoot = "Root",
  readerRoot = "Root",
) {
  return checkCompatibility(writer, reader, writerRoot, readerRoot);
}

// ----- identity: field number, not name -------------------------------------

test("renaming a field keeps the same number: compatible", () => {
  const w = `message Root { optional int32 old_name = 1; }`;
  const r = `message Root { optional int32 new_name = 1; }`;
  assert.deepEqual(review(w, r), { compatible: true, issues: [] });
});

test("field declaration order does not matter", () => {
  const w = `message Root {
  optional int32 a = 1;
  optional string b = 2;
  optional bool c = 3;
}`;
  const r = `message Root {
  optional bool c = 3;
  optional int32 a = 1;
  optional string b = 2;
}`;
  assert.deepEqual(review(w, r), { compatible: true, issues: [] });
});

test("same number changing scalar type is a type mismatch", () => {
  const w = `message Root { optional int32 a = 1; }`;
  const r = `message Root { optional string a = 1; }`;
  assert.deepEqual(review(w, r), {
    compatible: false,
    issues: [{ path: [1], issue: "type_mismatch" }],
  });
});

test("scalars sharing a wire type still mismatch (int32 vs bool)", () => {
  const w = `message Root { optional int32 a = 1; }`;
  const r = `message Root { optional bool a = 1; }`;
  assert.equal(review(w, r).compatible, false);
});

test("scalar vs message on the same number is a type mismatch", () => {
  const w = `message Root { optional int32 a = 1; }
message M { optional int32 x = 1; }`;
  const r = `message Root { optional M a = 1; }
message M { optional int32 x = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1], issue: "type_mismatch" },
  ]);
});

// ----- cardinality / required ------------------------------------------------

test("repeated vs singular is a cardinality mismatch", () => {
  const w = `message Root { repeated int32 a = 1; }`;
  const r = `message Root { optional int32 a = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1], issue: "cardinality_mismatch" },
  ]);
  // and in the reverse direction as well (direction stays writer -> reader)
  assert.deepEqual(review(r, w).issues, [
    { path: [1], issue: "cardinality_mismatch" },
  ]);
});

test("packed vs unpacked repeated numeric is mutually readable", () => {
  const w = `message Root { repeated int32 a = 1 [packed = true]; }`;
  const r = `message Root { repeated int32 a = 1; }`;
  assert.equal(review(w, r).compatible, true);
  assert.equal(review(r, w).compatible, true);
});

test("reader adding a required field is incompatible", () => {
  const w = `message Root { optional int32 a = 1; }`;
  const r = `message Root {
  optional int32 a = 1;
  required string b = 2;
}`;
  assert.deepEqual(review(w, r).issues, [
    { path: [2], issue: "required_added" },
  ]);
});

test("reader tightening optional to required is incompatible", () => {
  const w = `message Root { optional string a = 1; }`;
  const r = `message Root { required string a = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1], issue: "required_added" },
  ]);
});

test("reader relaxing required to optional is compatible", () => {
  const w = `message Root { required string a = 1; }`;
  const r = `message Root { optional string a = 1; }`;
  assert.equal(review(w, r).compatible, true);
});

test("a newly added optional/repeated reader field is fine; a dropped writer field is unknown data", () => {
  const w = `message Root {
  optional int32 gone = 9;
  optional int32 kept = 1;
}`;
  const r = `message Root {
  optional int32 kept = 1;
  optional string added = 2;
  repeated bool more = 3;
}`;
  assert.equal(review(w, r).compatible, true);
});

test("several kinds of differences on one field are all reported", () => {
  const w = `message Root { repeated int32 a = 1; }`;
  const r = `message Root { required string a = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1], issue: "type_mismatch" },
    { path: [1], issue: "cardinality_mismatch" },
  ]);
});

// ----- deep submessages ------------------------------------------------------

test("type change inside a nested message is reported with its full path", () => {
  const w = `message Root { optional Inner x = 1; }
message Inner { optional int32 v = 1; }`;
  const r = `message Root { optional Inner x = 1; }
message Inner { optional string v = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1, 1], issue: "type_mismatch" },
  ]);
});

test("cardinality change inside a nested message is reported", () => {
  const w = `message Root { repeated Inner xs = 1; }
message Inner { optional int32 v = 1; }`;
  const r = `message Root { repeated Inner xs = 1; }
message Inner { repeated int32 v = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1, 1], issue: "cardinality_mismatch" },
  ]);
});

test("required tightening inside a nested message is reported", () => {
  const w = `message Root { optional Inner x = 1; }
message Inner { optional string v = 1; }`;
  const r = `message Root { optional Inner x = 1; }
message Inner { required string v = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1, 1], issue: "required_added" },
  ]);
});

test("message fields are matched by referenced structure, not by name", () => {
  const w = `message Root { optional Payload p = 1; }
message Payload { required string id = 1; optional int32 n = 2; }`;
  const r = `message Root { optional Data d = 1; }
message Data { required string id = 1; optional int32 n = 2; }`;
  assert.equal(review(w, r).compatible, true);
});

test("conflicts under renamed message fields are still found", () => {
  const w = `message Root { optional Payload p = 1; }
message Payload { optional int32 v = 1; }`;
  const r = `message Root { optional Data d = 1; }
message Data { optional string v = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1, 1], issue: "type_mismatch" },
  ]);
});

test("deeper conflicts survive an incompatible parent edge", () => {
  // repeated -> singular at field 1, but the nested type also changes; both
  // the edge difference and the reachable difference inside get reported.
  const w = `message Root { repeated Inner xs = 1; }
message Inner { optional int32 v = 1; }`;
  const r = `message Root { optional Inner xs = 1; }
message Inner { optional string v = 1; }`;
  assert.deepEqual(review(w, r).issues, [
    { path: [1], issue: "cardinality_mismatch" },
    { path: [1, 1], issue: "type_mismatch" },
  ]);
});

// ----- reachability -----------------------------------------------------------

test("messages unreachable from the entry root are ignored", () => {
  const w = `message Root { optional int32 a = 1; }
message Unused { optional int32 shared = 1; }`;
  const r = `message Root { optional int32 a = 1; }
message Unused { required string totally = 1; required bytes deep = 2; }`;
  assert.equal(review(w, r).compatible, true);
});

test("only the named entry root is reviewed, even with other roots present", () => {
  const schema = (t: string) => `
message Good { optional int32 a = 1; }
message Bad { ${t} }`;
  // Good vs Good compatible despite Bad differing wildly in the same files
  assert.equal(
    review(schema("optional int32 a = 1;"), schema("required string a = 1;"), "Good", "Good")
      .compatible,
    true,
  );
  assert.deepEqual(
    review(schema("optional int32 a = 1;"), schema("required string a = 1;"), "Bad", "Bad")
      .issues,
    [
      { path: [1], issue: "type_mismatch" },
      { path: [1], issue: "required_added" },
    ],
  );
});

// ----- recursion ---------------------------------------------------------------

test("self-referential messages terminate", () => {
  const w = `message Node {
  optional int32 value = 1;
  optional Node next = 2;
}`;
  const r = `message Node {
  optional int32 value = 1;
  optional Node next = 2;
}`;
  assert.equal(review(w, r, "Node", "Node").compatible, true);
});

test("mutual recursion terminates and reports the reachable conflict once", () => {
  const w = `message A { optional B b = 1; }
message B {
  optional A a = 1;
  optional int32 f = 2;
}`;
  const r = `message A { optional B b = 1; }
message B {
  optional A a = 1;
  optional string f = 2;
}`;
  assert.deepEqual(review(w, r, "A", "A").issues, [
    { path: [1, 2], issue: "type_mismatch" },
  ]);
});

test("recursive conflicts are reported at the shortest stable path", () => {
  // Leaf is reachable via a.leaf ([1,2]) and b.leaf ([2,2]); BFS picks [1,2].
  const w = `message Root {
  optional Inner a = 1;
  optional Inner b = 2;
}
message Inner {
  optional int32 x = 1;
  optional Leaf leaf = 2;
}
message Leaf { optional int32 v = 1; }`;
  const r = `message Root {
  optional Inner a = 1;
  optional Inner b = 2;
}
message Inner {
  optional int32 x = 1;
  optional Leaf leaf = 2;
}
message Leaf { optional string v = 1; }`;
  const result = review(w, r);
  assert.deepEqual(result.issues, [
    { path: [1, 2, 1], issue: "type_mismatch" },
  ]);
  // deterministic across repeated runs
  assert.deepEqual(review(w, r), result);
});

test("direct conflict at the root is shorter than any recursive path", () => {
  const w = `message Node {
  optional string here = 1;
  optional Node next = 2;
}`;
  const r = `message Node {
  optional int32 here = 1;
  optional Node next = 2;
}`;
  assert.deepEqual(review(w, r, "Node", "Node").issues, [
    { path: [1], issue: "type_mismatch" },
  ]);
});

// ----- failures ---------------------------------------------------------------

test("an unparseable schema fails the whole review (no partial verdict)", () => {
  const good = `message Root { optional int32 a = 1; }`;
  const bad = `message Root { optional int32 a = }`;
  assert.throws(() => review(bad, good), CompileError);
  assert.throws(() => review(good, bad), CompileError);
});

test("an unknown entry root fails the review", () => {
  const w = `message Root { optional int32 a = 1; }`;
  assert.throws(() => review(w, w, "Missing", "Root"), /writer entry root/);
  assert.throws(() => review(w, w, "Root", "Missing"), /reader entry root/);
});

test("unresolved type references in either schema fail the review", () => {
  const good = `message Root { optional int32 a = 1; }`;
  const bad = `message Root { optional Ghost a = 1; }`;
  assert.throws(() => review(bad, good), CompileError);
  assert.throws(() => review(good, bad), CompileError);
});

// ----- CLI --------------------------------------------------------------------

const cliPath = fileURLToPath(
  new URL("../dist/src/compat-cli.js", import.meta.url),
);

function runCli(
  dir: string,
  writerSrc: string,
  readerSrc: string,
  roots: [string, string],
  report?: string,
): { status: number; stdout: string; report?: string } {
  const w = join(dir, "writer.proto");
  const r = join(dir, "reader.proto");
  writeFileSync(w, writerSrc);
  writeFileSync(r, readerSrc);
  const out = report === undefined ? undefined : join(dir, report);
  const args = [cliPath, w, r, roots[0], roots[1]];
  if (out) args.push(out);
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
  } catch (e) {
    status = (e as { status?: number }).status ?? -1;
    stdout = ((e as { stdout?: string }).stdout) ?? "";
  }
  return {
    status,
    stdout,
    report: out !== undefined && existsSync(out) ? readFileSync(out, "utf8") : undefined,
  };
}

const GOOD = `message Root { optional int32 a = 1; }`;

test("CLI: compatible schemas exit 0 and write a compatible report", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  const res = runCli(dir, GOOD, GOOD, ["Root", "Root"], "report.json");
  assert.equal(res.status, 0);
  assert.match(res.report!, /"compatible": true/);
});

test("CLI: incompatible schemas exit 1 and the report matches the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  const bad = `message Root { required string a = 1; }`;
  const res = runCli(dir, GOOD, bad, ["Root", "Root"], "report.json");
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.report!) as {
    compatible: boolean;
    issues: { path: number[]; issue: string }[];
  };
  assert.equal(parsed.compatible, false);
  assert.deepEqual(parsed.issues, [
    { path: [1], issue: "type_mismatch" },
    { path: [1], issue: "required_added" },
  ]);
  // the exit status and the written report must be the same judgment
  assert.equal(res.status === 1, !parsed.compatible);
});

test("CLI: parse failure exits 2 and preserves the previous report file", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  const first = runCli(dir, GOOD, GOOD, ["Root", "Root"], "report.json");
  assert.equal(first.status, 0);
  const before = readFileSync(join(dir, "report.json"), "utf8");
  const invalid = `message Root { optional int32 a = }`;
  const second = runCli(dir, invalid, GOOD, ["Root", "Root"], "report.json");
  assert.equal(second.status, 2);
  assert.equal(readFileSync(join(dir, "report.json"), "utf8"), before);
});

test("CLI: invalid entry root exits 2 and preserves the previous report file", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  runCli(dir, GOOD, GOOD, ["Root", "Root"], "report.json");
  const before = readFileSync(join(dir, "report.json"), "utf8");
  const res = runCli(dir, GOOD, GOOD, ["Nope", "Root"], "report.json");
  assert.equal(res.status, 2);
  assert.equal(readFileSync(join(dir, "report.json"), "utf8"), before);
});

test("CLI: without an output path the report goes to stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  const res = runCli(dir, GOOD, GOOD, ["Root", "Root"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /"compatible": true/);
});
