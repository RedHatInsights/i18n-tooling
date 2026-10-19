import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = JSON.parse(await readFile("locales/translation-template.json", "utf8"));
const compiled = Object.fromEntries(
  Object.entries(source)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, descriptor]) => [id, descriptor.defaultMessage]),
);
const outputIndex = process.argv.indexOf("--out-file");
const outputPath = resolve(outputIndex < 0 ? "src/locales/en.json" : process.argv[outputIndex + 1]);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(compiled, null, 2)}\n`);
