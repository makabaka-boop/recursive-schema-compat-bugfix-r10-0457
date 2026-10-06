import { readFileSync, writeFileSync } from "node:fs";
import { checkCompatibility } from "./compatibility.js";
const [left, right, leftRoot, rightRoot, output] = process.argv.slice(2);
try {
  if (!left || !right || !leftRoot || !rightRoot)
    throw new Error("two schemas and two roots required");
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
} catch (error) {
  console.error(String(error));
  process.exitCode = 2;
}
