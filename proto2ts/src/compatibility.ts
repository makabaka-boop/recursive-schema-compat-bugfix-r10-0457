/**
 * One-direction source-compatibility review.
 *
 * The question answered here is: can a message written by the *writer*
 * schema always be read by the *reader* schema without losing a known value?
 *
 *   - fields are matched by field *number*; renaming a field is compatible;
 *   - exact scalar type must match (wire type alone is not enough — e.g.
 *     int32 and bool share wire type 0 but decode to different values);
 *   - repeated-ness must match; packed vs unpacked repeated numerics are
 *     mutually readable, so `packed` never participates in the comparison;
 *   - a field the writer drops is unknown to the reader and is preserved,
 *     so it is fine;
 *   - a field newly required by the reader, or one the reader tightens from
 *     optional to required, makes a legal writer message unreadable.
 *
 * Message-typed fields are compared by the structure they reference, not by
 * the message name, and only the part of each schema reachable from the
 * requested entry root is visited. Recursive message graphs are handled by
 * remembering the (writer, reader) message pairs already compared, so the
 * walk always terminates; a breadth-first walk makes every reported path a
 * shortest conflict path.
 */

import { parseProto, SCALAR_TYPES } from "./compiler/parser.js";
import type {
  FieldDecl,
  MessageDecl,
  ProtoFile,
} from "./compiler/parser.js";

export type CompatIssueKind =
  | "type_mismatch"
  | "cardinality_mismatch"
  | "required_added";

export interface CompatIssue {
  /** Field-number path from the entry root; shortest possible for the pair. */
  path: number[];
  issue: CompatIssueKind;
}

export interface CompatResult {
  compatible: boolean;
  issues: CompatIssue[];
}

const SCALAR_SET = new Set<string>(SCALAR_TYPES);

function indexMessages(file: ProtoFile): Map<string, MessageDecl> {
  const byName = new Map<string, MessageDecl>();
  for (const m of file.messages) byName.set(m.name, m);
  return byName;
}

/** Fields walked in ascending field-number order so the report is stable. */
function orderedFields(m: MessageDecl): FieldDecl[] {
  return [...m.fields].sort((x, y) => x.no - y.no);
}

interface QueueEntry {
  writer: MessageDecl;
  reader: MessageDecl;
  /** Field-number path by which this pair is reachable from the roots. */
  prefix: number[];
}

/**
 * Review `writerRoot` of the writer schema against `readerRoot` of the
 * reader schema. Throws CompileError when either source is invalid, and
 * Error when either named entry root is absent.
 */
export function checkCompatibility(
  writer: string,
  reader: string,
  writerRoot: string,
  readerRoot: string,
): CompatResult {
  // Parse both sources completely before producing any report, so an invalid
  // one leaves the caller's previous report untouched (the CLI never writes).
  const writerFile = parseProto(writer);
  const readerFile = parseProto(reader);
  const writerMessages = indexMessages(writerFile);
  const readerMessages = indexMessages(readerFile);
  const rootW = writerMessages.get(writerRoot);
  if (rootW === undefined)
    throw new Error(
      `writer entry root '${writerRoot}' is not declared in the writer schema`,
    );
  const rootR = readerMessages.get(readerRoot);
  if (rootR === undefined)
    throw new Error(
      `reader entry root '${readerRoot}' is not declared in the reader schema`,
    );

  const issues: CompatIssue[] = [];

  // Breadth-first over message pairs: the first path reaching a pair is a
  // shortest path, which is the one recorded. Message pairs are the cycle
  // cut, so self/ mutual references terminate the walk.
  const seen = new Set<string>([`${rootW.name}\0${rootR.name}`]);
  const queue: QueueEntry[] = [{ writer: rootW, reader: rootR, prefix: [] }];
  let head = 0;
  while (head < queue.length) {
    const { writer: wm, reader: rm, prefix } = queue[head++]!;

    // Match by number; writer-only numbers are unknown fields to the reader
    // and are harmless, so only reader fields need an entry in the writer.
    const byNo = new Map<number, FieldDecl>();
    for (const f of wm.fields) byNo.set(f.no, f);

    for (const rf of orderedFields(rm)) {
      const wf = byNo.get(rf.no);
      const path = [...prefix, rf.no];
      if (wf === undefined) {
        // A new required field can be missing in a legal writer message.
        // New optional/repeated fields simply default on the reader side.
        if (rf.label === "required")
          issues.push({ path, issue: "required_added" });
        continue;
      }

      const wScalar = SCALAR_SET.has(wf.typeName);
      const rScalar = SCALAR_SET.has(rf.typeName);
      // Exact scalar identity, or message-vs-message; wire type alone is not
      // enough (int32 vs bool share wire type 0 but disagree on values).
      if (wScalar !== rScalar || (wScalar && wf.typeName !== rf.typeName)) {
        issues.push({ path, issue: "type_mismatch" });
      }
      // repeated must stay repeated; the packed declaration never matters
      // because readers accept both wire forms for repeated numerics.
      const wRepeated = wf.label === "repeated";
      const rRepeated = rf.label === "repeated";
      if (wRepeated !== rRepeated) {
        issues.push({ path, issue: "cardinality_mismatch" });
      } else if (wf.label !== "required" && rf.label === "required") {
        // tightening optional -> required (a writer message may omit it).
        issues.push({ path, issue: "required_added" });
      }

      // Descend into referenced messages by their structure regardless of
      // the pair's own differences, so conflicts deeper down are not hidden.
      if (!wScalar && !rScalar) {
        const childW = writerMessages.get(wf.typeName);
        const childR = readerMessages.get(rf.typeName);
        // Parser validation already resolved every type reference.
        if (childW !== undefined && childR !== undefined) {
          const key = `${childW.name}\0${childR.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            queue.push({ writer: childW, reader: childR, prefix: path });
          }
        }
      }
    }
  }

  return { compatible: issues.length === 0, issues };
}
