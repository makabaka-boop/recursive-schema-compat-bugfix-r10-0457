import { parseProto } from "./compiler/index.js";
export function checkCompatibility(
  writer: string,
  reader: string,
  writerRoot: string,
  readerRoot: string,
) {
  const a = parseProto(writer),
    b = parseProto(reader);
  const left = a.messages.find((x) => x.name === writerRoot)!;
  const right = b.messages.find((x) => x.name === readerRoot)!;
  const issues: any[] = [];
  for (const f of right.fields) {
    const old = left.fields.find((x) => x.name === f.name);
    if (!old || old.typeName !== f.typeName || old.packed !== f.packed)
      issues.push({ path: [f.no], issue: "field_changed" });
  }
  return { compatible: issues.length === 0, issues };
}
