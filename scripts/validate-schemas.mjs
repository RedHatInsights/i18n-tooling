import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDirectory = join(repositoryRoot, "schemas");
const fixturesDirectory = join(schemasDirectory, "fixtures");
const schemaFiles = (await readdir(schemasDirectory))
  .filter((file) => file.endsWith(".schema.json"))
  .sort();

if (schemaFiles.length === 0) {
  throw new Error("No schemas/*.schema.json files found");
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

for (const schemaFile of schemaFiles) {
  const schema = JSON.parse(await readFile(join(schemasDirectory, schemaFile), "utf8"));
  const validate = ajv.compile(schema);
  const schemaName = basename(schemaFile, ".schema.json");
  const fixtureFiles = (await readdir(fixturesDirectory))
    .filter((file) => file.startsWith(`${schemaName}.`))
    .sort();

  if (fixtureFiles.length === 0) {
    throw new Error(`No fixtures found for ${schemaFile}`);
  }

  for (const fixtureFile of fixtureFiles) {
    const shouldBeValid = fixtureFile.endsWith(".valid.json");
    const shouldBeInvalid = fixtureFile.endsWith(".invalid.json");
    if (!shouldBeValid && !shouldBeInvalid) {
      throw new Error(`Fixture must end in .valid.json or .invalid.json: ${fixtureFile}`);
    }

    const fixture = JSON.parse(await readFile(join(fixturesDirectory, fixtureFile), "utf8"));
    const isValid = validate(fixture);
    if (isValid !== shouldBeValid) {
      const errors = JSON.stringify(validate.errors ?? [], null, 2);
      throw new Error(
        `${fixtureFile} expected ${shouldBeValid ? "valid" : "invalid"}, got ${isValid}:\n${errors}`,
      );
    }
  }

  console.log(`${schemaFile}: compiled; ${fixtureFiles.length} fixtures passed`);
}
