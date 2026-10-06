/**
 * Directional schema-compatibility checker.
 *
 * `checkCompatibility(writer, reader, writerRoot, readerRoot)` answers one
 * question: can data written under the *writer* schema (rooted at
 * `writerRoot`) be read back under the *reader* schema (rooted at
 * `readerRoot`)? The maintainer runs it both ways (old->new and new->old)
 * before deploying a changed message definition.
 *
 * The comparison follows what the reader actually does with the writer's
 * bytes, not what the declaration text looks like:
 *
 *  - Fields are matched by **field number** (the wire key). Renaming a
 *    field — or a message — changes nothing on the wire and is compatible.
 *  - `[packed = ...]` is ignored: the runtime decodes repeated packable
 *    scalars from both the packed and the unpacked form regardless of the
 *    declared option, so toggling it cannot break a reader.
 *  - A shared field number whose **type** changes (scalar vs. message, or a
 *    different scalar) is reported as `type_changed`.
 *  - A shared field number whose **label** changes — occurrence count
 *    (repeated vs. singular) or required-ness (required vs. optional) — is
 *    reported as `label_changed`.
 *  - A field the reader declares `required` whose number the writer never
 *    emits is reported as `required_added`: the reader's required-field
 *    validation would reject the writer's data.
 *  - Fields only the writer declares arrive as unknown fields and are
 *    preserved; fields only the reader declares (optional/repeated) simply
 *    decode as absent. Neither is an issue.
 *
 * Message-typed fields shared by both sides are compared recursively, so
 * type/label/required-ness changes deep inside nested messages are found.
 * The traversal is a breadth-first walk of (writer message, reader message)
 * pairs reachable from the two roots: declarations unrelated to the chosen
 * entry points are ignored, recursive references terminate (each pair is
 * compared once), and the first — therefore shortest — path to each pair is
 * the one reported. Issues are sorted by path so the report is stable.
 */

import { parseProto } from "./compiler/index.js";
import type { FieldDecl, MessageDecl, ProtoFile } from "./compiler/index.js";

export type CompatIssueKind =
  | "type_changed"
  | "label_changed"
  | "required_added";

export interface CompatIssue {
  /** Field numbers from the entry message down to the conflict. */
  path: number[];
  issue: CompatIssueKind;
  /** Declarations of the two sides, e.g. "required int32 id". */
  writer?: string;
  reader?: string;
}

export interface CompatReport {
  compatible: boolean;
  issues: CompatIssue[];
}

function describe(f: FieldDecl): string {
  return `${f.label} ${f.typeName} ${f.name}`;
}

function byName(file: ProtoFile): Map<string, MessageDecl> {
  return new Map(file.messages.map((m) => [m.name, m]));
}

function rootOf(file: ProtoFile, name: string, side: string): MessageDecl {
  const msg = file.messages.find((m) => m.name === name);
  if (msg === undefined) {
    const known = file.messages.map((m) => m.name).join(", ");
    throw new Error(
      `${side} root message '${name}' not found (declared: ${known})`,
    );
  }
  return msg;
}

function parseSide(source: string, side: string): ProtoFile {
  try {
    return parseProto(source);
  } catch (e) {
    if (e instanceof Error) e.message = `${side} schema: ${e.message}`;
    throw e;
  }
}

function compareIssues(a: CompatIssue, b: CompatIssue): number {
  const n = Math.min(a.path.length, b.path.length);
  for (let i = 0; i < n; i++) {
    if (a.path[i] !== b.path[i]) return a.path[i]! - b.path[i]!;
  }
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0;
}

export function checkCompatibility(
  writer: string,
  reader: string,
  writerRoot: string,
  readerRoot: string,
): CompatReport {
  const wFile = parseSide(writer, "writer");
  const rFile = parseSide(reader, "reader");
  const wMsgs = byName(wFile);
  const rMsgs = byName(rFile);

  const issues: CompatIssue[] = [];
  const seen = new Set<string>(); // compared (or queued) message pairs
  const queue: Array<{ w: MessageDecl; r: MessageDecl; path: number[] }> = [];

  const enqueue = (w: MessageDecl, r: MessageDecl, path: number[]): void => {
    const key = `${w.name}\0${r.name}`;
    if (seen.has(key)) return; // recursion and diamonds end here
    seen.add(key);
    queue.push({ w, r, path });
  };
  enqueue(
    rootOf(wFile, writerRoot, "writer"),
    rootOf(rFile, readerRoot, "reader"),
    [],
  );

  while (queue.length > 0) {
    const { w, r, path } = queue.shift()!;
    const wFields = new Map(w.fields.map((f) => [f.no, f]));
    // Ascending field numbers keep the traversal (and thus the report)
    // independent of declaration order.
    const rFields = [...r.fields].sort((a, b) => a.no - b.no);

    for (const rf of rFields) {
      const fieldPath = [...path, rf.no];
      const wf = wFields.get(rf.no);
      if (wf === undefined) {
        if (rf.label === "required") {
          issues.push({
            path: fieldPath,
            issue: "required_added",
            reader: describe(rf),
          });
        }
        continue;
      }
      const wIsMsg = wMsgs.has(wf.typeName);
      const rIsMsg = rMsgs.has(rf.typeName);
      if (wIsMsg !== rIsMsg || (!wIsMsg && wf.typeName !== rf.typeName)) {
        issues.push({
          path: fieldPath,
          issue: "type_changed",
          writer: describe(wf),
          reader: describe(rf),
        });
        continue; // payloads no longer line up; nothing meaningful below
      }
      if (wf.label !== rf.label) {
        issues.push({
          path: fieldPath,
          issue: "label_changed",
          writer: describe(wf),
          reader: describe(rf),
        });
      }
      // packed is deliberately not compared: both wire forms decode either way.
      if (wIsMsg) {
        enqueue(wMsgs.get(wf.typeName)!, rMsgs.get(rf.typeName)!, fieldPath);
      }
    }
  }

  issues.sort(compareIssues);
  return { compatible: issues.length === 0, issues };
}
