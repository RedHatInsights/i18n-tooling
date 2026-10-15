import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureName = process.argv[2];
const onboardedRoot = process.argv[3] ? resolve(process.argv[3]) : undefined;

const fixtures = {
  "formatjs-frontend": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "i18n/phrase-tms.json",
      "locales/translation-template.json",
      "src/locales/en.json",
      ".github/workflows/locale-validation.yml",
    ],
    // Hub mode is the default: the i18n-hub runs submit and reconcile.
    forbiddenFiles: [
      ".github/workflows/phrase-submit.yml",
      ".github/workflows/phrase-reconcile.yml",
    ],
    sections: ["checks", "generated", "catalogDirectories", "sourceLint"],
    packageScript: "translations:validate",
    configChecks: [
      ["sourceLint.catalog", "locales/translation-template.json"],
      ["checks[0].source.path", "locales/translation-template.json"],
      ["checks[0].targets[0].path", "src/locales/en.json"],
      ["generated[0].path", "locales/translation-template.json"],
      ["generated[1].path", "src/locales/en.json"],
    ],
    minimumGenerated: 2,
    unchangedFiles: ["src/Services.jsx"],
    absentFiles: ["src/locales/fr.json"],
    minimumOccurrences: [["src/messages.js", "description:", 6]],
    requiredText: [
      ["src/messages.js", 'defaultMessage: "Stop the bill for service."'],
      ["src/messages.js", 'defaultMessage: "{count, plural, one {# result} other {# results}}"'],
    ],
  },
  "formatjs-generated-ids": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "locales/translation-template.json",
      "src/locales/en.json",
    ],
    sections: ["checks", "generated", "catalogDirectories", "sourceLint"],
    packageScript: "translations:validate",
    configChecks: [
      ["sourceLint.files[0]", "src/App.jsx"],
      ["checks[0].source.path", "locales/translation-template.json"],
      ["checks[0].targets[0].path", "src/locales/en.json"],
    ],
    requireSourceLintWithoutCatalog: true,
    minimumGenerated: 2,
    unchangedFiles: ["scripts/extract-messages.mjs"],
    minimumOccurrences: [["src/App.jsx", "description=", 2]],
    requiredText: [
      ["src/App.jsx", 'defaultMessage="Welcome, {name}."'],
      ["src/App.jsx", 'defaultMessage="{count, plural, one {# task} other {# tasks}} remain."'],
    ],
    forbiddenText: [["src/App.jsx", " id="]],
  },
  "feo-frontend": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "deploy/locales/translation-template.json",
      "node_modules/@redhat-cloud-services/frontend-components-config-utilities/package.json",
      "node_modules/@redhat-cloud-services/frontend-components-config-utilities/schemas/frontend-crd.schema.json",
    ],
    sections: ["checks", "feo", "catalogDirectories"],
    packageScript: "translations:validate",
    configChecks: [
      ["feo[0].template", "deploy/frontend.yaml"],
      ["feo[0].source", "deploy/locales/translation-template.json"],
    ],
    requireEmptyFEOLocales: true,
    unchangedFiles: [
      "node_modules/@redhat-cloud-services/frontend-components-config-utilities/package.json",
      "node_modules/@redhat-cloud-services/frontend-components-config-utilities/index.js",
      "node_modules/@redhat-cloud-services/frontend-components-config-utilities/schemas/frontend-crd.schema.json",
    ],
    absentFiles: ["deploy/locales/zh-CN.json"],
    requiredText: [
      ["deploy/frontend.yaml", "defaultDocumentTitle: Identity Management"],
      ["deploy/locales/translation-template.json", '"description"'],
    ],
    forbiddenText: [["deploy/frontend.yaml", "locales:"]],
  },
  "keyed-icu-backend": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "locales/en.json",
      "locales/fr.json",
      "Makefile",
    ],
    sections: ["checks", "catalogDirectories"],
    makeTarget: "i18n-validate",
    configChecks: [
      ["checks[0].source.path", "locales/en.json"],
      ["checks[0].source.adapter", "icu-json"],
      ["checks[0].source.locale", "en"],
      ["checks[0].targets[0].path", "locales/fr.json"],
      ["checks[0].targets[0].locale", "fr"],
    ],
    unchangedFiles: ["locales/en.json", "locales/fr.json"],
  },
  "openapi-problem-details": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "api/problem-details.yaml",
      "locales/i18n-en.json",
      "Makefile",
      "scripts/convert-openapi-catalog.mjs",
    ],
    sections: ["checks", "generated", "catalogDirectories"],
    makeTarget: "i18n-validate",
    configChecks: [
      ["checks[0].source.path", "locales/i18n-en.json"],
      ["checks[0].source.adapter", "icu-json"],
      ["checks[0].source.locale", "en"],
      ["catalogDirectories[0].path", "locales"],
      ["generated[0].path", "locales/i18n-en.json"],
      ["generated[0].command", "node"],
      ["generated[0].args[0]", "scripts/convert-openapi-catalog.mjs"],
    ],
    minimumGenerated: 1,
    unchangedFiles: ["api/problem-details.yaml", "locales/i18n-en.json"],
    requiredText: [
      ["scripts/convert-openapi-catalog.mjs", "openapi-problem-details"],
      ["scripts/convert-openapi-catalog.mjs", "process.env.I18N_PIPELINE_CLI"],
      ["scripts/convert-openapi-catalog.mjs", '"i18n-pipeline"'],
    ],
  },
  "already-onboarded": {
    config: "i18n/catalog-validation.json",
    requiredFiles: [
      "i18n/catalog-validation.json",
      "locales/translation-template.json",
      "src/locales/en.json",
      "src/messages.js",
    ],
    sections: ["checks", "catalogDirectories", "sourceLint"],
    packageScript: "translations:validate",
    configChecks: [
      ["checks[0].source.path", "locales/translation-template.json"],
      ["sourceLint.catalog", "locales/translation-template.json"],
    ],
    unchangedFiles: [
      "i18n/catalog-validation.json",
      "package.json",
      "locales/translation-template.json",
      "src/locales/en.json",
      "src/messages.js",
    ],
  },
};

fixtures["formatjs-frontend-standalone"] = {
  ...fixtures["formatjs-frontend"],
  fixture: "formatjs-frontend",
  requiredFiles: [
    ...fixtures["formatjs-frontend"].requiredFiles,
    ".github/workflows/phrase-submit.yml",
    ".github/workflows/phrase-reconcile.yml",
  ],
  forbiddenFiles: [],
  // A reusable workflow sees only the secrets its caller maps.
  requiredText: [
    ...fixtures["formatjs-frontend"].requiredText,
    ...["phrase-submit.yml", "phrase-reconcile.yml"].flatMap((name) =>
      ["PHRASE_PLATFORM_API_TOKEN", "APP_CLIENT_ID", "APP_PRIVATE_KEY"].map((secret) => [
        `.github/workflows/${name}`,
        `${secret}: \${{ secrets.${secret} }}`,
      ]),
    ),
  ],
  // The wizard's standalone default is App mode, so the App lines are uncommented.
  forbiddenText: ["phrase-submit.yml", "phrase-reconcile.yml"].flatMap((name) =>
    ["# APP_CLIENT_ID:", "# APP_PRIVATE_KEY:"].map((text) => [`.github/workflows/${name}`, text]),
  ),
};

const failures = [];
function fail(item) {
  failures.push(item);
}

if (!fixtureName || !Object.hasOwn(fixtures, fixtureName)) {
  console.error(
    `Usage: node scripts/check-skill-fixture.mjs <fixture-name> <path-to-onboarded-copy>`,
  );
  console.error(`Fixtures: ${Object.keys(fixtures).join(", ")}`);
  process.exit(2);
}
if (!onboardedRoot || !existsSync(onboardedRoot) || !statSync(onboardedRoot).isDirectory()) {
  console.error("Provide an existing path to the onboarded fixture copy.");
  process.exit(2);
}

const expectation = fixtures[fixtureName];
const fixtureRoot = join(
  repositoryRoot,
  "tests/skill-fixtures",
  expectation.fixture ?? fixtureName,
);
const cliPath = resolve(
  process.env.I18N_PIPELINE_CLI ?? join(repositoryRoot, "packages/i18n-pipeline/dist/cli.js"),
);

if (!existsSync(cliPath)) {
  console.error(`FAIL built CLI exists: ${cliPath}`);
  console.error(
    "Build i18n-pipeline with npm run build or set I18N_PIPELINE_CLI to a built cli.js.",
  );
  process.exit(1);
}

for (const relativePath of expectation.requiredFiles) {
  if (!existsSync(join(onboardedRoot, relativePath))) {
    fail(`required file exists: ${relativePath}`);
  }
}

for (const relativePath of expectation.absentFiles ?? []) {
  if (existsSync(join(onboardedRoot, relativePath))) {
    fail(`generated file is absent until Phrase delivers it: ${relativePath}`);
  }
}

for (const relativePath of expectation.forbiddenFiles ?? []) {
  if (existsSync(join(onboardedRoot, relativePath))) {
    fail(`file is absent in the selected Phrase mode: ${relativePath}`);
  }
}

const configPath = join(onboardedRoot, expectation.config);
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.version !== 1) fail(`${expectation.config} has version 1`);
  for (const section of expectation.sections) {
    if (!Object.hasOwn(config, section)) fail(`${expectation.config} has ${section}`);
  }
  for (const [propertyPath, expectedValue] of expectation.configChecks ?? []) {
    const actualValue = propertyPath.split(".").reduce((value, part) => {
      const match = /^([A-Za-z0-9_-]+)(?:\[(\d+)\])?$/.exec(part);
      if (!match || value == null) return undefined;
      const next = value[match[1]];
      return match[2] === undefined ? next : next?.[Number(match[2])];
    }, config);
    if (actualValue !== expectedValue) {
      fail(
        `${expectation.config} ${propertyPath} equals ${JSON.stringify(expectedValue)} (received ${JSON.stringify(actualValue)})`,
      );
    }
  }
  if ((expectation.minimumGenerated ?? 0) > (config.generated?.length ?? 0)) {
    fail(`${expectation.config} has at least ${expectation.minimumGenerated} generated entries`);
  }
  if (
    expectation.requireSourceLintWithoutCatalog &&
    Object.hasOwn(config.sourceLint ?? {}, "catalog")
  ) {
    fail(`${expectation.config} omits sourceLint.catalog for generated IDs`);
  }
  if (expectation.requireEmptyFEOLocales) {
    const locales = config.feo?.[0]?.locales;
    if (
      !locales ||
      typeof locales !== "object" ||
      Array.isArray(locales) ||
      Object.keys(locales).length !== 0
    ) {
      fail(
        `${expectation.config} sets feo[0].locales to an empty object until Phrase delivers translations`,
      );
    }
  }
} catch (error) {
  fail(`${expectation.config} parses as JSON: ${String(error)}`);
}

if (expectation.packageScript) {
  try {
    const manifest = JSON.parse(readFileSync(join(onboardedRoot, "package.json"), "utf8"));
    const script = manifest.scripts?.[expectation.packageScript];
    if (typeof script !== "string" || !script.includes("i18n-pipeline validate-ci --mode error")) {
      fail(
        `package.json script ${expectation.packageScript} runs i18n-pipeline validate-ci --mode error`,
      );
    }
  } catch (error) {
    fail(`package.json parses and contains ${expectation.packageScript}: ${String(error)}`);
  }
}

if (expectation.makeTarget) {
  const makefilePath = join(onboardedRoot, "Makefile");
  if (!existsSync(makefilePath)) {
    fail("Makefile exists with an i18n-validate target");
  } else {
    const makefile = readFileSync(makefilePath, "utf8");
    const target = new RegExp(`^${expectation.makeTarget}:\\s*$`, "m");
    if (!target.test(makefile) || !makefile.includes("i18n-pipeline validate-ci --mode error")) {
      fail(`Makefile target ${expectation.makeTarget} runs i18n-pipeline validate-ci --mode error`);
    }
  }
}

for (const relativePath of expectation.unchangedFiles ?? []) {
  const sourcePath = join(fixtureRoot, relativePath);
  const targetPath = join(onboardedRoot, relativePath);
  if (!existsSync(sourcePath)) {
    fail(`fixture source exists for unchanged-file comparison: ${relativePath}`);
  } else if (!existsSync(targetPath)) {
    fail(`unchanged file still exists: ${relativePath}`);
  } else if (!readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    fail(`unchanged file matches fixture source: ${relativePath}`);
  }
}

for (const [relativePath, text] of expectation.requiredText ?? []) {
  if (!existsSync(join(onboardedRoot, relativePath))) continue;
  if (!readFileSync(join(onboardedRoot, relativePath), "utf8").includes(text)) {
    fail(`${relativePath} retains required text ${JSON.stringify(text)}`);
  }
}

// Drafted wording varies between runs, so count occurrences instead of matching text.
for (const [relativePath, text, minimum] of expectation.minimumOccurrences ?? []) {
  if (!existsSync(join(onboardedRoot, relativePath))) continue;
  const count = readFileSync(join(onboardedRoot, relativePath), "utf8").split(text).length - 1;
  if (count < minimum) {
    fail(
      `${relativePath} contains ${JSON.stringify(text)} at least ${minimum} times (found ${count})`,
    );
  }
}

for (const [relativePath, text] of expectation.forbiddenText ?? []) {
  if (
    existsSync(join(onboardedRoot, relativePath)) &&
    readFileSync(join(onboardedRoot, relativePath), "utf8").includes(text)
  ) {
    fail(`${relativePath} omits forbidden text ${JSON.stringify(text)}`);
  }
}

const validation = spawnSync(
  process.execPath,
  [cliPath, "validate-ci", "--root", onboardedRoot, "--mode", "error"],
  {
    cwd: onboardedRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, I18N_PIPELINE_CLI: cliPath },
  },
);
if (validation.error) {
  fail(`validate-ci --mode error starts: ${validation.error.message}`);
} else if (validation.status !== 0) {
  fail(`validate-ci --mode error exits 0 (received ${validation.status ?? validation.signal})`);
  const output = `${validation.stdout ?? ""}${validation.stderr ?? ""}`;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    fail(`validate-ci: ${line}`);
  }
}

if (failures.length) {
  for (const item of failures) console.error(`FAIL ${item}`);
  process.exit(1);
}

console.log(`PASS ${fixtureName}: files, config, protected content, and validate-ci --mode error`);
