import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = await readFile("src/App.jsx", "utf8");
const messages = [];
const componentPattern = /<FormattedMessage\b([^>]*)\/>/g;
const attributePattern = /\b(defaultMessage|description)="((?:\\.|[^"\\])*)"/g;

for (const component of source.matchAll(componentPattern)) {
  const attributes = Object.create(null);
  for (const attribute of component[1].matchAll(attributePattern)) {
    attributes[attribute[1]] = JSON.parse(`"${attribute[2]}"`);
  }
  if (attributes.defaultMessage === undefined) continue;
  const id = createHash("sha256").update(attributes.defaultMessage).digest("hex").slice(0, 8);
  messages.push([id, attributes]);
}

const catalog = Object.fromEntries(
  messages
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, descriptor]) => [id, descriptor]),
);
const outputIndex = process.argv.indexOf("--out-file");
const outputPath = resolve(outputIndex < 0 ? "locales/translation-template.json" : process.argv[outputIndex + 1]);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
