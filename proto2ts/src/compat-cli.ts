#!/usr/bin/env node
/**
 * proto2ts compatibility CLI: can data written under one schema be read
 * under another?
 *
 *   proto2ts-compat <writer.proto> <reader.proto> <writerRoot> <readerRoot> [report.json]
 *
 * Checks one read direction, from the writer schema's entry message to the
 * reader schema's; run it twice with the roles swapped to cover both
 * directions of a deployment.
 *
 * Exit status mirrors the report exactly: 0 when the report says
 * compatible, 1 when it lists issues (the report is still written), and 2
 * on usage errors, unreadable files, schema parse failures or unknown entry
 * messages — in those cases any existing report file is left untouched.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { checkCompatibility } from "./compatibility.js";

function usage(): never {
  console.error(
    "usage: proto2ts-compat <writer.proto> <reader.proto> <writerRoot> <readerRoot> [report.json]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 4 || args.length > 5) usage();
const [writerPath, readerPath, writerRoot, readerRoot, output] = args as [
  string,
  string,
  string,
  string,
  string?,
];

try {
  const result = checkCompatibility(
    readFileSync(writerPath, "utf8"),
    readFileSync(readerPath, "utf8"),
    writerRoot,
    readerRoot,
  );
  // The check completed: only now is the report (over)written.
  const text = JSON.stringify(result, null, 2) + "\n";
  if (output !== undefined) writeFileSync(output, text);
  else process.stdout.write(text);
  process.exitCode = result.compatible ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
