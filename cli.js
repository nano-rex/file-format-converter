// Command-line conversion: bun cli.js <input> <output>
// The formats are taken from the file extensions.

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { convert, engineConversions } from "./src/convert.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: bun cli.js <input> <output>\n\nSupported conversions:");
  for (const [source, targets] of Object.entries(engineConversions)) console.error(`  ${source} -> ${targets.join(", ")}`);
  process.exit(2);
}

try {
  const target = extname(output).slice(1);
  const results = convert(await readFile(input), basename(output), extname(input).slice(1), target);
  if (results.length === 1) {
    await writeFile(output, results[0].data);
    console.log(output);
  } else {
    for (const result of results) {
      const path = join(dirname(output), result.name);
      await writeFile(path, result.data);
      console.log(path);
    }
  }
} catch (error) {
  console.error(`Conversion failed: ${error.message}`);
  process.exit(1);
}
