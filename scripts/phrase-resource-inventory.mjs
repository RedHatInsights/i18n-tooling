#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COLUMNS = [
  "type",
  "name",
  "uid",
  "source_language",
  "target_languages",
  "languages",
  "entry_count",
  "counts_by_language",
  "client",
  "domain",
  "subdomain",
  "business_unit",
  "created_at",
];
const HELP = `Usage: node scripts/phrase-resource-inventory.mjs --output <path.csv> [--region eu|us]

Reads only Phrase TM/TB listing and metadata. Requires PHRASE_PLATFORM_API_TOKEN.
Writes a sortable CSV of token-visible resources (segments for TMs, terms for TBs).
Output already exists? Choose a new path; this script will not overwrite it.`;

export function parseOptions(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  let output;
  let region = "eu";
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || !["--output", "--region"].includes(args[i])) {
      throw new Error(`Expected --output <path.csv> [--region eu|us]. See --help.`);
    }
    if (seen.has(args[i])) throw new Error(`Duplicate option: ${args[i]}`);
    seen.add(args[i]);
    if (args[i] === "--output") output = args[i + 1];
    else region = args[i + 1];
  }
  if (!output || !output.endsWith(".csv")) throw new Error("Provide --output <path.csv>");
  if (region !== "eu" && region !== "us") throw new Error("Region must be eu or us");
  return { output, region };
}

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Phrase ${label}`);
  }
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Phrase ${label}`);
  return value;
}

function nameOf(reference) {
  return typeof reference?.name === "string" ? reference.name : "";
}

function languages(value) {
  return Array.isArray(value) ? value.filter((lang) => typeof lang === "string").join("; ") : "";
}

function languageCounts(metadata, countField) {
  if (!metadata) return "";
  return Object.entries(record(metadata, "language metadata"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([lang, value]) =>
        `${lang}: ${count(typeof value === "number" ? value : value?.[countField], "language count")}`,
    )
    .join("; ");
}

function csvCell(value) {
  const text = String(value ?? "");
  // Resource metadata is remote data. Prefix spreadsheet formulas to keep CSV safe to open.
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(rows) {
  return (
    [
      COLUMNS.join(","),
      ...rows.map((row) => COLUMNS.map((key) => csvCell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}

export async function collectInventory({
  platformApiToken,
  region = "eu",
  fetcher = globalThis.fetch,
  sleep = (ms) => new Promise((done) => globalThis.setTimeout(done, ms)),
  now = Date.now,
  progress = () => {},
  minIntervalMs = 500,
}) {
  if (!platformApiToken?.trim()) throw new Error("PHRASE_PLATFORM_API_TOKEN is required");
  if (region !== "eu" && region !== "us") throw new Error("Region must be eu or us");
  const platformHost = region === "eu" ? "eu.phrase.com" : "us.phrase.com";
  const apiHost = region === "eu" ? "cloud.memsource.com" : "us.cloud.memsource.com";
  const oauth = await fetcher(`https://${platformHost}/idm/oauth/token`, {
    method: "POST",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new globalThis.URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: platformApiToken,
      subject_token_type: "urn:phrase:params:oauth:token-type:api_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  if (!oauth.ok) throw new Error(`Phrase OAuth returned HTTP ${oauth.status}`);
  const token = record(await oauth.json(), "OAuth response").access_token;
  if (typeof token !== "string" || !token) throw new Error("Phrase OAuth returned no access token");

  let lastStart;
  async function get(path) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (lastStart !== undefined) await sleep(Math.max(0, minIntervalMs - (now() - lastStart)));
      lastStart = now();
      let response;
      try {
        response = await fetcher(`https://${apiHost}/web${path}`, {
          method: "GET",
          signal: globalThis.AbortSignal.timeout(30_000),
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        });
      } catch {
        if (attempt === 4) throw new Error(`Phrase GET failed after retries: ${path}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error(`Phrase GET ${path} returned HTTP ${response.status}`);
        const header = response.headers.get("retry-after");
        const seconds = Number(header);
        const delay =
          header && Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : header && Number.isFinite(Date.parse(header))
              ? Math.max(0, Date.parse(header) - now())
              : 1000 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`Phrase GET ${path} returned HTTP ${response.status}`);
      return record(await response.json(), "GET response");
    }
  }

  async function list(path, pageSize) {
    const items = [];
    const seen = new Set();
    let totalPages;
    let totalElements;
    for (let pageNumber = 0; totalPages === undefined || pageNumber < totalPages; pageNumber++) {
      const page = await get(`${path}?pageNumber=${pageNumber}&pageSize=${pageSize}`);
      count(page.totalPages, "totalPages");
      count(page.totalElements, "totalElements");
      if (
        !Number.isSafeInteger(page.pageNumber) ||
        page.pageNumber !== pageNumber ||
        !Array.isArray(page.content) ||
        (totalPages !== undefined &&
          (totalPages !== page.totalPages || totalElements !== page.totalElements))
      ) {
        throw new Error(`Inconsistent Phrase pagination for ${path}`);
      }
      totalPages = page.totalPages;
      totalElements = page.totalElements;
      for (const raw of page.content) {
        const item = record(raw, "resource");
        if (
          typeof item.uid !== "string" ||
          !item.uid ||
          typeof item.name !== "string" ||
          seen.has(item.uid)
        ) {
          throw new Error(`Invalid or duplicate Phrase resource in ${path}`);
        }
        seen.add(item.uid);
        items.push(item);
      }
    }
    if (items.length !== totalElements) throw new Error(`Incomplete Phrase listing for ${path}`);
    return items;
  }

  const rows = [];
  for (const [type, listPath, pageSize, metadataPath, field] of [
    ["TM", "/api2/v2/transMemories", 100, "/api2/v1/transMemories", "segmentsCount"],
    ["TB", "/api2/v1/termBases", 50, "/api2/v1/termBases", "termsCount"],
  ]) {
    const items = await list(listPath, pageSize);
    progress(`${type}: ${items.length} visible resources`);
    for (const item of items) {
      const metadata = await get(
        `${metadataPath}/${encodeURIComponent(item.uid)}/metadata${type === "TM" ? "?byLanguage=true" : ""}`,
      );
      rows.push({
        type,
        name: item.name,
        uid: item.uid,
        source_language: type === "TM" ? (item.sourceLang ?? "") : "",
        target_languages: type === "TM" ? languages(item.targetLangs) : "",
        languages: type === "TB" ? languages(item.langs) : "",
        entry_count: count(metadata[field], `${type} ${field}`),
        counts_by_language: languageCounts(metadata.metadataByLanguage, field),
        client: nameOf(item.client),
        domain: nameOf(item.domain),
        subdomain: nameOf(item.subDomain),
        business_unit: nameOf(item.businessUnit),
        created_at: item.dateCreated ?? "",
      });
    }
    progress(`${type}: ${items.length} metadata records read`);
  }
  rows.sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === "TM" ? -1 : 1) ||
      b.entry_count - a.entry_count ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(options.output);
  let exists = true;
  try {
    await access(output);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (exists) throw new Error(`Output file already exists: ${output}`);
  const rows = await collectInventory({
    platformApiToken: env.PHRASE_PLATFORM_API_TOKEN,
    region: options.region,
    progress: (message) => console.error(message),
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, toCsv(rows), { flag: "wx", mode: 0o600 });
  console.error(`Wrote ${rows.length} token-visible TM/TB rows to ${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Inventory failed");
    process.exitCode = 1;
  });
}
