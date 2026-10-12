import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareVersions, parseVersion, setVersion } from "./set-version.mjs";

test("accepts SemVer and rejects malformed or leading-zero versions", () => {
  for (const value of ["0.0.0", "1.2.3-alpha.0+build.01", "1.2.3-0a", "1.2.3+001"]) {
    assert.doesNotThrow(() => parseVersion(value));
  }
  for (const value of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+", "1.2.3\n"]) {
    assert.throws(() => parseVersion(value), /Invalid semver/);
  }
});

test("compares SemVer precedence, including arbitrary-size numbers and build metadata", () => {
  const versions = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];
  for (let i = 1; i < versions.length; i++) {
    assert.equal(compareVersions(versions[i - 1], versions[i]), -1);
    assert.equal(compareVersions(versions[i], versions[i - 1]), 1);
  }
  assert.equal(compareVersions("1.0.0+abc", "1.0.0+def"), 0);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.1"), 0);
  assert.equal(compareVersions("99999999999999999999.0.0", "99999999999999999998.0.0"), 1);
});

test("updates only package versions and the exact plugin dependency; refuses either downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "set-version-"));
  try {
    const plugin = { name: "@redhat-cloud-services/eslint-plugin-i18n", version: "0.1.0" };
    const pipeline = { version: "0.2.0", dependencies: { [plugin.name]: "0.1.0", other: "1.0.0" } };
    const paths = ["eslint-plugin-i18n", "i18n-pipeline"].map((name) =>
      join(root, "packages", name, "package.json"),
    );
    for (const [i, path] of paths.entries()) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify([plugin, pipeline][i]));
    }
    await writeFile(join(root, "bun.lock"), "unchanged");
    await assert.rejects(setVersion("0.1.1", root), /downgrade/);
    assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), plugin);
    await assert.rejects(setVersion("invalid", root), /Invalid semver/);
    await setVersion("0.2.0", root);
    await setVersion("1.0.0", root);
    assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), { ...plugin, version: "1.0.0" });
    assert.deepEqual(JSON.parse(await readFile(paths[1], "utf8")), {
      ...pipeline,
      version: "1.0.0",
      dependencies: { ...pipeline.dependencies, [plugin.name]: "1.0.0" },
    });
    assert.equal(await readFile(join(root, "bun.lock"), "utf8"), "unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
