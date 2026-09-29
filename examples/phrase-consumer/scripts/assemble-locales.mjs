import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { argv } from "node:process";

const localeDirectory = resolve(argv[2] ?? "src/locales");
const dataFile = resolve(argv[3] ?? join(localeDirectory, "data.json"));
const excludedFiles = new Set([basename(dataFile), "data.json"]);
const files = (await readdir(localeDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => entry.name)
  .filter((filename) => !excludedFiles.has(filename))
  .sort();
const locales = Object.create(null);

for (const filename of files) {
  const fileLocale = basename(filename, ".json");
  const locale = fileLocale === "translations" ? "en" : fileLocale;
  if (Object.hasOwn(locales, locale)) {
    throw new Error(`Multiple locale files map to "${locale}"`);
  }
  const catalog = JSON.parse(await readFile(join(localeDirectory, filename), "utf8"));
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    throw new Error(`Locale catalog must be a JSON object: ${filename}`);
  }
  locales[locale] = catalog;
}

await writeFile(dataFile, `${JSON.stringify(locales, null, 2)}\n`);
