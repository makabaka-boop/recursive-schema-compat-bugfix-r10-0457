#!/usr/bin/env node
/**
 * One-direction compatibility review CLI.
 *
 *   compat-cli writer.proto reader.proto WriterRoot ReaderRoot [report.json]
 *
 * Exit status mirrors the verdict in the report:
 *   0 - compatible
 *   1 - incompatible (report written)
 *   2 - usage error, unparseable schema, or unknown entry root. In this case
 *       no report is written, so a previous report file stays in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { checkCompatibility } from "./compatibility.js";

function main(): void {
  const [left, right, leftRoot, rightRoot, output] = process.argv.slice(2);
  if (!left || !right || !leftRoot || !rightRoot)
    throw new Error("usage: compat-cli writer.proto reader.proto WriterRoot ReaderRoot [report.json]");

  // Both schemas are fully validated before anything is written: a throw
  // below skips the writeFileSync entirely and preserves any old report.
  const result = checkCompatibility(
    readFileSync(left, "utf8"),
    readFileSync(right, "utf8"),
    leftRoot,
    rightRoot,
  );
  const text = JSON.stringify(result, null, 2) + "\n";
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);

  if (!result.compatible) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}
