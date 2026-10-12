import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// SemVer 2.0.0: numeric prerelease identifiers cannot have leading zeroes.
export function parseVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid semver: ${value}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") ?? [] };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export async function setVersion(version, root = process.cwd()) {
  parseVersion(version);
  const paths = ["eslint-plugin-i18n", "i18n-pipeline"].map((name) =>
    resolve(root, "packages", name, "package.json"),
  );
  const packages = await Promise.all(
    paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  for (const pkg of packages) {
    if (compareVersions(version, pkg.version) < 0) {
      throw new Error(`Refusing downgrade from ${pkg.version} to ${version}`);
    }
    pkg.version = version;
  }
  packages[1].dependencies[packages[0].name] = version;
  for (let i = 0; i < paths.length; i++) {
    await writeFile(paths[i], `${JSON.stringify(packages[i], null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/set-version.mjs <version>");
    await setVersion(process.argv[2]);
    console.log("Version updated. Run bun install, then bun install --yarn to refresh lockfiles.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
