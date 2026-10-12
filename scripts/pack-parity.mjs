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
const pm = values.pm;
const image = values.image;
const engine = values["container-engine"];
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
async function write(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
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
    for (const file of ["README.md", "LICENSE", "package.json"]) {
      assert.ok(
        pack.files.some((entry) => entry.path === file),
        `${name} tarball missing ${file}`,
      );
    }
    tarballs.push(join(temporary, pack.filename));
  }
  const consumer = join(temporary, "consumer");
  // Until the packages are on the registry, the CLI's dependency on the plugin
  // must resolve to the local tarball; only npm does that without an override.
  const [pluginTarball, pipelineTarball] = tarballs.map((tarball) => `file:${tarball}`);
  const pluginOverride = { "@redhat-cloud-services/eslint-plugin-i18n": pluginTarball };
  await write(consumer, "package.json", {
    name: "pack-consumer",
    version: "1.0.0",
    private: true,
    dependencies: {
      ...pluginOverride,
      "@redhat-cloud-services/i18n-pipeline": pipelineTarball,
    },
    overrides: pluginOverride,
    pnpm: { overrides: pluginOverride },
  });
  const installArgs =
    pm === "npm"
      ? ["install", "--ignore-scripts", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts"];
  run(pm, installArgs, consumer);
  const cli = join(consumer, "node_modules/.bin/i18n-pipeline");
  const version = JSON.parse(
    await readFile(join(repository, "packages/i18n-pipeline/package.json"), "utf8"),
  ).version;
  assert.ok(run(cli, ["version"], consumer).includes(version));
  run(
    process.execPath,
    [
      "-e",
      'const plugin = require("@redhat-cloud-services/eslint-plugin-i18n").default; require("node:assert/strict").ok(plugin.configs.source.length);',
    ],
    consumer,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import plugin from "@redhat-cloud-services/eslint-plugin-i18n"; import assert from "node:assert/strict"; assert.ok(plugin.configs.source.length);',
    ],
    consumer,
  );

  for (const scenario of [
    "valid",
    "invalid-icu",
    "warning-only",
    "catalog-mismatch",
    "generated-drift",
    "custom-adapter",
  ]) {
    const root = join(temporary, scenario);
    const config = {
      version: 1,
      checks: [
        {
          source: { path: "locales/en.json", adapter: "formatjs-json", locale: "en" },
          targets: [{ path: "locales/fr.json", adapter: "icu-json", locale: "fr" }],
        },
      ],
      generated: [],
      sourceLint: { files: ["src/**/*.js"] },
    };
    await write(root, "package.json", { name: scenario, version: "1.0.0" });
    await write(root, "locales/en.json", { greeting: { defaultMessage: "Hello {name}." } });
    await write(root, "locales/fr.json", { greeting: "Bonjour {name}." });
    await write(
      root,
      "src/messages.js",
      'formatMessage({ id: "greeting", defaultMessage: "Hello {name}." });',
    );
    if (scenario === "invalid-icu") {
      await write(
        root,
        "src/messages.js",
        'formatMessage({ id: "bad", defaultMessage: "{count, plural, one {item}}" });',
      );
    }
    if (scenario === "warning-only") {
      await write(
        root,
        "src/messages.js",
        'formatMessage({ id: "items", defaultMessage: "{count, plural, one {one item} other {{count} items}}" });',
      );
    }
    if (scenario === "catalog-mismatch")
      await write(root, "locales/fr.json", { greeting: "Bonjour." });
    if (scenario === "generated-drift") {
      await write(root, "locales/generated.json", { value: "checked-in" });
      await write(
        root,
        "generate.mjs",
        'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({ value: "fresh" }));',
      );
      config.generated.push({
        path: "locales/generated.json",
        command: "node",
        args: ["generate.mjs", "{output}"],
        updateCommand: "node generate.mjs",
      });
    }
    if (scenario === "custom-adapter") {
      await write(root, "package.json", {
        i18nTooling: { catalogAdapters: { "consumer-json": "consumer-json-adapter" } },
      });
      await write(root, "node_modules/consumer-json-adapter/package.json", {
        name: "consumer-json-adapter",
        type: "module",
        exports: { import: "./adapter.mjs", require: "./adapter.cjs" },
      });
      await write(
        root,
        "node_modules/consumer-json-adapter/adapter.cjs",
        'exports.default = { id: "consumer-json", read() {}, write() {} };',
      );
      await write(
        root,
        "node_modules/consumer-json-adapter/adapter.mjs",
        `export default {
        id: "consumer-json",
        read(document, context) {
          return { locale: context.locale, messages: Object.fromEntries(Object.entries(document).map(([id, pattern]) => [id, { pattern, metadata: {} }])) };
        },
        write(catalog) { return Object.fromEntries(Object.entries(catalog.messages).map(([id, message]) => [id, message.pattern])); }
      };`,
      );
      await write(root, "locales/en.json", { greeting: "Hello {name}." });
      config.checks[0].source.adapter = "consumer-json";
      config.checks[0].targets[0].adapter = "consumer-json";
    }
    await write(root, "i18n/catalog-validation.json", config);
    for (const mode of ["warn", "error"]) {
      const results = join(root, `results-${mode}`);
      const hasError = ["invalid-icu", "catalog-mismatch", "generated-drift"].includes(scenario);
      run(
        cli,
        ["validate-ci", "--root", root, "--mode", mode, "--results-dir", results],
        consumer,
        mode === "error" && hasError ? 1 : 0,
      );
      assert.deepEqual((await readdir(results)).sort(), [...resultNames].sort());
      const actual = Object.fromEntries(
        await Promise.all(
          resultNames.map(async (name) => [name, await readFile(join(results, name), "utf8")]),
        ),
      );
      assert.equal(
        actual.I18N_STATUS,
        hasError || scenario === "warning-only" ? "findings" : "pass",
      );
      assert.equal(actual.I18N_MODE, mode);
      assert.equal(actual.I18N_CONFIG, "config");
      assert.equal(actual.I18N_TOOL_VERSION, version);
      assert.equal(actual.I18N_ERRORS, hasError ? "1" : "0");
      if (scenario === "warning-only") assert.ok(Number(actual.I18N_WARNINGS) > 0);
      else assert.equal(actual.I18N_WARNINGS, "0");
      const imageResult = JSON.parse(
        run(
          engine,
          [
            "run",
            "--rm",
            "--read-only",
            "--network",
            "none",
            "--tmpfs",
            "/tmp",
            "--env",
            "HOME=/nonexistent",
            "--volume",
            `${root}:/consumer:ro`,
            "--entrypoint",
            "node",
            image,
            "-e",
            containerProbe,
            mode,
          ],
          repository,
        ),
      );
      assert.equal(
        imageResult.exitCode,
        mode === "error" && hasError ? 1 : 0,
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
