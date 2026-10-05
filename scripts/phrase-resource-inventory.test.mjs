import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectInventory, main, parseOptions, toCsv } from "./phrase-resource-inventory.mjs";

const json = (value, status = 200, headers = {}) =>
  new globalThis.Response(JSON.stringify(value), { status, headers });

function mockPhrase(routes, calls) {
  return async (url, init) => {
    const path = new globalThis.URL(url).pathname + new globalThis.URL(url).search;
    calls.push({ url, path, init });
    if (path === "/idm/oauth/token") return json({ access_token: "short-lived" });
    const result = routes[path];
    if (!result) throw new Error(`Unexpected API call: ${path}`);
    return typeof result === "function" ? result() : json(result);
  };
}

const tm = (uid, name) => ({
  uid,
  name,
  sourceLang: "en_us",
  targetLangs: ["ja"],
  domain: { name: "UI" },
});
const tb = (uid, name) => ({ uid, name, langs: ["en", "ja"], client: { name: "Red Hat" } });
const page = (content, pageNumber, totalPages, totalElements) => ({
  content,
  pageNumber,
  totalPages,
  totalElements,
});

function routes() {
  return {
    "/web/api2/v2/transMemories?pageNumber=0&pageSize=100": page([tm("t1", "Small")], 0, 2, 2),
    "/web/api2/v2/transMemories?pageNumber=1&pageSize=100": page([tm("t2", "Large")], 1, 2, 2),
    "/web/api2/v1/transMemories/t1/metadata?byLanguage=true": {
      segmentsCount: 2,
      metadataByLanguage: { ja: { segmentsCount: 2 }, en_us: { segmentsCount: 2 } },
    },
    "/web/api2/v1/transMemories/t2/metadata?byLanguage=true": {
      segmentsCount: 900,
      metadataByLanguage: { en_us: { segmentsCount: 900 }, ja: { segmentsCount: 899 } },
    },
    "/web/api2/v1/termBases?pageNumber=0&pageSize=50": page([tb("b1", "Terms")], 0, 1, 1),
    "/web/api2/v1/termBases/b1/metadata": {
      termsCount: 40,
      metadataByLanguage: { en: 20, ja: 20 },
    },
  };
}

test("lists all pages, reads metadata only, sorts within resource type, and never sends the token to TMS as a parameter", async () => {
  const calls = [];
  const rows = await collectInventory({
    platformApiToken: "secret-token",
    fetcher: mockPhrase(routes(), calls),
    minIntervalMs: 0,
  });
  assert.deepEqual(
    rows.map(({ type, name, uid, entry_count }) => [type, name, uid, entry_count]),
    [
      ["TM", "Large", "t2", 900],
      ["TM", "Small", "t1", 2],
      ["TB", "Terms", "b1", 40],
    ],
  );
  assert.equal(rows[2].counts_by_language, "en: 20; ja: 20");
  assert.equal(rows[0].counts_by_language, "en_us: 900; ja: 899");
  assert.equal(rows[0].domain, "UI");
  assert.equal(rows[2].client, "Red Hat");
  assert.equal(calls.length, 7);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    new globalThis.URLSearchParams(calls[0].init.body).get("subject_token"),
    "secret-token",
  );
  assert.ok(
    calls
      .slice(1)
      .every(
        ({ path, init }) =>
          init.method === "GET" &&
          path.startsWith("/web/api2/") &&
          !path.includes("secret-token") &&
          new globalThis.Headers(init.headers).get("Authorization") === "Bearer short-lived",
      ),
  );
});

test("reads term-base per-language counts from termsCount metadata", async () => {
  const api = routes();
  api["/web/api2/v1/termBases/b1/metadata"] = {
    termsCount: 40,
    metadataByLanguage: { en: { termsCount: 20 }, ja: { termsCount: 20 } },
  };
  const rows = await collectInventory({
    platformApiToken: "secret-token",
    fetcher: mockPhrase(api, []),
    minIntervalMs: 0,
  });

  assert.equal(rows.find(({ type }) => type === "TB").counts_by_language, "en: 20; ja: 20");
});

test("waits between GETs and retries HTTP 429 using Retry-After", async () => {
  const calls = [];
  const api = routes();
  let tries = 0;
  api["/web/api2/v1/termBases/b1/metadata"] = () =>
    ++tries === 1 ? json({}, 429, { "Retry-After": "3" }) : json({ termsCount: 40 });
  const delays = [];
  let clock = 0;
  await collectInventory({
    platformApiToken: "secret-token",
    fetcher: mockPhrase(api, calls),
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
  });
  assert.equal(tries, 2);
  assert.ok(delays.includes(500));
  assert.ok(delays.includes(3000));
});

test("rejects incomplete or duplicate listings instead of writing partial results", async () => {
  const api = routes();
  api["/web/api2/v2/transMemories?pageNumber=1&pageSize=100"] = page([], 1, 2, 2);
  await assert.rejects(
    collectInventory({ platformApiToken: "x", fetcher: mockPhrase(api, []), minIntervalMs: 0 }),
    /Incomplete Phrase listing/,
  );
  api["/web/api2/v2/transMemories?pageNumber=1&pageSize=100"] = page(
    [tm("t1", "duplicate")],
    1,
    2,
    2,
  );
  await assert.rejects(
    collectInventory({ platformApiToken: "x", fetcher: mockPhrase(api, []), minIntervalMs: 0 }),
    /duplicate Phrase resource/,
  );
});

test("escapes spreadsheet formulas, quotes, newlines, and commas in CSV", () => {
  const text = toCsv([
    {
      type: "TB",
      name: '=HYPERLINK("x", "y")\nnew',
      uid: "abc",
      entry_count: 4,
      languages: "en; ja",
    },
  ]);
  assert.ok(text.startsWith("type,name,uid,"));
  assert.ok(text.includes('"\'=HYPERLINK(""x"", ""y"")\nnew"'));
  assert.ok(text.includes(",abc,"));
});

test("requires a CSV output path and rejects unsupported regions before authentication", () => {
  assert.deepEqual(parseOptions(["--help"]), { help: true });
  assert.deepEqual(parseOptions(["--output", "inventory/list.csv"]), {
    output: "inventory/list.csv",
    region: "eu",
  });
  assert.throws(() => parseOptions([]), /Provide --output/);
  assert.throws(() => parseOptions(["--output", "list.csv", "--region", "mars"]), /Region must be/);
  assert.throws(
    () => parseOptions(["--output", "list.csv", "--output", "other.csv"]),
    /Duplicate option/,
  );
  assert.throws(
    () => parseOptions(["--output", "list.csv", "--region", "eu", "--region", "us"]),
    /Duplicate option/,
  );
});

test("refuses to overwrite a previous inventory before attempting authentication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "phrase-resource-inventory-"));
  try {
    const output = join(dir, "existing.csv");
    await writeFile(output, "keep this file\n");
    await assert.rejects(main(["--output", output], {}), /Output file already exists/);
    assert.equal(await readFile(output, "utf8"), "keep this file\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
