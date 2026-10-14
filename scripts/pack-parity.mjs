import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    pm: { type: "string", default: "npm" },
    image: { type: "string" },
    "container-engine": { type: "string", default: "docker" },
  },
});
const { pm, image, "container-engine": engine } = values;
if (!["npm", "bun", "pnpm"].includes(pm) || !image || !["docker", "podman"].includes(engine)) {
  throw new Error(
    "Usage: node scripts/pack-parity.mjs --image <same-commit-image> [--pm npm|bun|pnpm] [--container-engine docker|podman]",
  );
}
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expected,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
async function write(root, files) {
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  }
}
const resultNames = [
  "I18N_STATUS",
  "I18N_ERRORS",
  "I18N_WARNINGS",
  "I18N_MODE",
  "I18N_CONFIG",
  "I18N_TOOL_VERSION",
];

assert.equal(
  run("git", ["status", "--porcelain"], repository).trim(),
  "",
  "Parity requires a committed clean checkout so the image revision identifies its sources",
);
const [imageMetadata] = JSON.parse(run(engine, ["image", "inspect", image], repository));
assert.equal(
  imageMetadata.Config.Labels?.["org.opencontainers.image.revision"],
  run("git", ["rev-parse", "HEAD"], repository).trim(),
  "Parity image must be built from this commit with its revision label",
);
const containerProbe = `
const { spawnSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");
if (process.getuid() === 0) throw new Error("Parity image must run non-root");
const result = spawnSync("i18n-pipeline", ["validate-ci", "--root", "/consumer", "--mode", process.argv[1], "--results-dir", "/tmp/results"], { encoding: "utf8" });
if (result.error) throw result.error;
require("node:assert/strict").deepEqual(readdirSync("/tmp/results").sort(), ${JSON.stringify([...resultNames].sort())});
const results = Object.fromEntries(${JSON.stringify(resultNames)}.map(name => [name, readFileSync("/tmp/results/" + name, "utf8")]));
process.stdout.write(JSON.stringify({ exitCode: result.status, results, stderr: result.stderr }));
`;

const customAdapter = `export default {
  id: "consumer-json",
  read(document, context) {
    return { locale: context.locale, messages: Object.fromEntries(Object.entries(document).map(([id, pattern]) => [id, { pattern, metadata: {} }])) };
  },
  write(catalog) { return Object.fromEntries(Object.entries(catalog.messages).map(([id, message]) => [id, message.pattern])); }
};`;
const message = (id, defaultMessage) =>
  `formatMessage({ id: ${JSON.stringify(id)}, defaultMessage: ${JSON.stringify(defaultMessage)} });`;
// Each scenario overrides the valid baseline; `errors` scenarios fail in error mode.
const scenarios = {
  valid: {},
  "invalid-icu": {
    errors: true,
    files: { "src/messages.js": message("bad", "{count, plural, one {item}}") },
  },
  "warning-only": {
    warnings: true,
    files: {
      "src/messages.js": message("items", "{count, plural, one {one item} other {{count} items}}"),
    },
  },
  "catalog-mismatch": { errors: true, files: { "locales/fr.json": { greeting: "Bonjour." } } },
  "generated-drift": {
    errors: true,
    files: {
      "locales/generated.json": { value: "checked-in" },
      "generate.mjs":
        'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({ value: "fresh" }));',
    },
    generated: [
      {
        path: "locales/generated.json",
        command: "node",
        args: ["generate.mjs", "{output}"],
        updateCommand: "node generate.mjs",
      },
    ],
  },
  "custom-adapter": {
    adapter: "consumer-json",
    files: {
      "package.json": {
        i18nTooling: { catalogAdapters: { "consumer-json": "consumer-json-adapter" } },
      },
      "locales/en.json": { greeting: "Hello {name}." },
      // The CommonJS entry must not be selected.
      "node_modules/consumer-json-adapter/package.json": {
        name: "consumer-json-adapter",
        type: "module",
        exports: { import: "./adapter.mjs", require: "./adapter.cjs" },
      },
      "node_modules/consumer-json-adapter/adapter.cjs":
        'exports.default = { id: "consumer-json", read() {}, write() {} };',
      "node_modules/consumer-json-adapter/adapter.mjs": customAdapter,
    },
  },
};

const temporary = await realpath(await mkdtemp(join(tmpdir(), "i18n-pack-parity-")));
try {
  run("npm", ["run", "build"], repository);
  const tarballs = [];
  for (const name of ["eslint-plugin-i18n", "i18n-pipeline"]) {
    const [pack] = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--pack-destination", temporary],
        join(repository, "packages", name),
      ),
    );
    tarballs.push(`file:${join(temporary, pack.filename)}`);
  }
  // Until the packages are on the registry, the CLI's dependency on the plugin
  // must resolve to the local tarball; only npm does that without an override.
  const pluginOverride = { "@redhat-cloud-services/eslint-plugin-i18n": tarballs[0] };
  const consumer = join(temporary, "consumer");
  await write(consumer, {
    "package.json": {
      name: "pack-consumer",
      version: "1.0.0",
      private: true,
      dependencies: { ...pluginOverride, "@redhat-cloud-services/i18n-pipeline": tarballs[1] },
      overrides: pluginOverride,
      pnpm: { overrides: pluginOverride },
    },
  });
  run(
    pm,
    ["install", "--ignore-scripts", ...(pm === "npm" ? ["--no-audit", "--no-fund"] : [])],
    consumer,
  );
  const cli = join(consumer, "node_modules/.bin/i18n-pipeline");
  const { version } = JSON.parse(
    await readFile(join(repository, "packages/i18n-pipeline/package.json"), "utf8"),
  );
  assert.ok(run(cli, ["version"], consumer).includes(version));
  const plugin = '"@redhat-cloud-services/eslint-plugin-i18n"';
  run(
    process.execPath,
    ["-e", `require("node:assert").ok(require(${plugin}).default.configs.source.length);`],
    consumer,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import p from ${plugin}; import a from "node:assert"; a.ok(p.configs.source.length);`,
    ],
    consumer,
  );

  for (const [
    scenario,
    { errors = false, warnings = false, files = {}, generated = [], adapter },
  ] of Object.entries(scenarios)) {
    const root = join(temporary, scenario);
    const target = { path: "locales/fr.json", adapter: adapter ?? "icu-json", locale: "fr" };
    await write(root, {
      "package.json": { name: scenario, version: "1.0.0" },
      "locales/en.json": { greeting: { defaultMessage: "Hello {name}." } },
      "locales/fr.json": { greeting: "Bonjour {name}." },
      "src/messages.js": message("greeting", "Hello {name}."),
      "i18n/catalog-validation.json": {
        version: 1,
        checks: [
          {
            source: { path: "locales/en.json", adapter: adapter ?? "formatjs-json", locale: "en" },
            targets: [target],
          },
        ],
        generated,
        sourceLint: { files: ["src/**/*.js"] },
      },
      ...files,
    });
    for (const mode of ["warn", "error"]) {
      const exitCode = mode === "error" && errors ? 1 : 0;
      const resultsDir = join(root, `results-${mode}`);
      run(
        cli,
        ["validate-ci", "--root", root, "--mode", mode, "--results-dir", resultsDir],
        consumer,
        exitCode,
      );
      assert.deepEqual((await readdir(resultsDir)).sort(), [...resultNames].sort());
      const actual = Object.fromEntries(
        await Promise.all(
          resultNames.map(async (name) => [name, await readFile(join(resultsDir, name), "utf8")]),
        ),
      );
      assert.equal(actual.I18N_STATUS, errors || warnings ? "findings" : "pass");
      assert.equal(actual.I18N_MODE, mode);
      assert.equal(actual.I18N_CONFIG, "config");
      assert.equal(actual.I18N_TOOL_VERSION, version);
      assert.equal(actual.I18N_ERRORS, errors ? "1" : "0");
      assert.ok(warnings ? Number(actual.I18N_WARNINGS) > 0 : actual.I18N_WARNINGS === "0");

      const imageResult = JSON.parse(
        run(
          engine,
          [
            ..."run --rm --read-only --network none --tmpfs /tmp --env HOME=/nonexistent".split(
              " ",
            ),
            ...["--volume", `${root}:/consumer:ro`, "--entrypoint", "node", image],
            ...["-e", containerProbe, mode],
          ],
          repository,
        ),
      );
      assert.equal(
        imageResult.exitCode,
        exitCode,
        `${scenario} (${mode}): image exit differs; ${imageResult.stderr}`,
      );
      assert.deepEqual(
        imageResult.results,
        actual,
        `${scenario} (${mode}): packed/image results differ`,
      );
      console.log(`${pm}: ${scenario} (${mode}) matches image`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
