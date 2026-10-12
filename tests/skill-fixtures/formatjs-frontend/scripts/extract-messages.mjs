import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = await readFile("src/messages.js", "utf8");
const descriptorPattern = /\bid:\s*("(?:\\.|[^"\\])*")\s*,\s*defaultMessage:\s*("(?:\\.|[^"\\])*")(?:\s*,\s*description:\s*("(?:\\.|[^"\\])*")\s*)?/g;
const catalog = Object.create(null);

for (const match of source.matchAll(descriptorPattern)) {
  const [, rawId, rawMessage, rawDescription] = match;
  const descriptor = { defaultMessage: JSON.parse(rawMessage) };
  if (rawDescription !== undefined) descriptor.description = JSON.parse(rawDescription);
  catalog[JSON.parse(rawId)] = descriptor;
}

const outputIndex = process.argv.indexOf("--out-file");
const outputPath = resolve(outputIndex < 0 ? "locales/translation-template.json" : process.argv[outputIndex + 1]);
const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(sorted, null, 2)}\n`);
