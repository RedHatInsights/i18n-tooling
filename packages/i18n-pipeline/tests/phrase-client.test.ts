import { describe, expect, it } from "vitest";
import { PhraseClient, PhraseAsyncRequestError, phraseEndpoints } from "../src/phrase-client.js";

describe("PhraseClient", () => {
  it("creates a reusable JSON ICU import profile from project defaults", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const projectDefaults = {
      fileFormat: "auto-detect",
      json: { contextNotePath: "description", icuSubFilter: false },
      inputCharset: "UTF-8",
    };
    const expectedSettings = {
      ...projectDefaults,
      fileFormat: "json",
      json: { contextNotePath: "description", icuSubFilter: true },
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url.endsWith("/idm/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      if (url.endsWith("/projects/project-uid/importSettings")) {
        return new Response(JSON.stringify(projectDefaults));
      }
      if (url.includes("/api2/v1/importSettings?pageNumber=0&pageSize=50")) {
        return new Response(JSON.stringify({ content: [], pageNumber: 0, totalPages: 0 }));
      }
      if (url.endsWith("/api2/v1/importSettings") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          fileImportSettings: Record<string, unknown>;
        };
        expect(body.fileImportSettings).toEqual(expectedSettings);
        expect(body.name).toMatch(/^consumer-formatjs-icu [0-9a-f]{12}$/);
        return new Response(JSON.stringify({ uid: "new-settings" }), { status: 201 });
      }
      if (url.endsWith("/api2/v1/importSettings/new-settings")) {
        const create = calls.find(
          (call) => call.url.endsWith("/api2/v1/importSettings") && call.init?.method === "POST",
        );
        const body = JSON.parse(String(create?.init?.body)) as { name: string };
        return new Response(
          JSON.stringify({
            uid: "new-settings",
            name: body.name,
            fileImportSettings: expectedSettings,
          }),
        );
      }
      throw new Error(`Unexpected Phrase request ${url}`);
    };
    const client = new PhraseClient({ platformApiToken: "platform-token", region: "eu", fetch });

    const result = await client.ensureJsonIcuImportSettings("project-uid", "consumer-formatjs-icu");

    expect(result).toMatchObject({ uid: "new-settings", created: true });
    expect(calls.map((call) => call.init?.method ?? "GET")).toEqual([
      "POST",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("reuses an existing reusable import profile when its settings match", async () => {
    const projectDefaults = {
      fileFormat: "json",
      json: { contextNotePath: "description", icuSubFilter: false },
    };
    const expectedSettings = {
      ...projectDefaults,
      json: { contextNotePath: "description", icuSubFilter: true },
    };
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith("/idm/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      if (url.endsWith("/projects/project-uid/importSettings")) {
        return new Response(JSON.stringify(projectDefaults));
      }
      if (url.includes("/api2/v1/importSettings?pageNumber=0&pageSize=50")) {
        return new Response(
          JSON.stringify({
            content: [{ uid: "existing-settings", name: "legacy-profile" }],
            pageNumber: 0,
            totalPages: 1,
          }),
        );
      }
      if (url.endsWith("/api2/v1/importSettings/existing-settings")) {
        return new Response(
          JSON.stringify({
            uid: "existing-settings",
            name: "legacy-profile",
            fileImportSettings: expectedSettings,
          }),
        );
      }
      throw new Error(`Unexpected Phrase request ${url}`);
    };
    const client = new PhraseClient({ platformApiToken: "platform-token", region: "eu", fetch });

    const result = await client.ensureJsonIcuImportSettings("project-uid", "consumer-formatjs-icu");

    expect(result).toEqual({ uid: "existing-settings", name: "legacy-profile", created: false });
    expect(calls.some((url) => url.endsWith("/api2/v1/importSettings"))).toBe(false);
  });

  it("exchanges a Platform API token and uploads the source catalog as a job", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(
          JSON.stringify({
            access_token: "short-lived-jwt",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          asyncRequest: { id: "import-42", action: "IMPORT_JOB" },
          jobs: [{ uid: "job-fr", targetLang: "fr", workflowLevel: 1 }],
          unsupportedFiles: [],
          warnings: [],
        }),
        { status: 201 },
      );
    };
    const client = new PhraseClient({
      platformApiToken: "personal-platform-token",
      region: "us",
      fetch,
    });
    const sourceBytes = new TextEncoder().encode('{"greeting":{"defaultMessage":"Hello"}}');

    const result = await client.createJob({
      projectUid: "project-uid",
      filename: "source catalog.json",
      sourceBytes,
      targetLangs: ["fr"],
      importSettingsUid: "import-settings-uid",
    });

    expect(result.asyncRequest.id).toBe("import-42");
    expect(result.jobs).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://us.phrase.com/idm/oauth/token");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(String(calls[0]?.init?.body)).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
    );
    expect(String(calls[0]?.init?.body)).toContain("subject_token=personal-platform-token");
    expect(String(calls[0]?.init?.body)).toContain(
      "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
    );

    const upload = calls[1];
    expect(upload?.url).toBe(
      "https://us.cloud.memsource.com/web/api2/v1/projects/project-uid/jobs",
    );
    const headers = new Headers(upload?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer short-lived-jwt");
    expect(JSON.parse(headers.get("Memsource") ?? "{}")).toEqual({
      targetLangs: ["fr"],
      importSettings: { uid: "import-settings-uid" },
    });
    expect(headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''source%20catalog.json",
    );
    expect(await (upload?.init?.body as Blob).text()).toBe(new TextDecoder().decode(sourceBytes));
  });

  it("uses region-specific Phrase Platform and TMS API endpoints", () => {
    expect(phraseEndpoints("eu")).toEqual({
      oauthTokenUrl: "https://eu.phrase.com/idm/oauth/token",
      apiBaseUrl: "https://cloud.memsource.com/web",
    });
    expect(phraseEndpoints("us")).toEqual({
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      apiBaseUrl: "https://us.cloud.memsource.com/web",
    });
  });

  it("accepts Phrase's nullable import error field when reading a job", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/idm/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      return new Response(
        JSON.stringify({
          uid: "job-zh",
          targetLang: "zh",
          workflowLevel: 1,
          lastWorkflowLevel: 1,
          status: "NEW",
          imported: true,
          importStatus: { status: "OK", errorMessage: null },
        }),
      );
    };
    const client = new PhraseClient({ platformApiToken: "platform-token", region: "eu", fetch });

    await expect(client.getJob("project-uid", "job-zh")).resolves.toMatchObject({
      uid: "job-zh",
      importStatus: { status: "OK", errorMessage: null },
    });
  });

  it("reports failed asynchronous operations without mislabeling them as HTTP errors", async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/idm/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      return new Response(
        JSON.stringify({ id: "import-failed", asyncResponse: { errorCode: "IMPORT_FAILED" } }),
      );
    };
    const client = new PhraseClient({
      platformApiToken: "platform-token",
      region: "eu",
      fetch,
    });

    await expect(client.waitForAsyncRequest("import-failed")).rejects.toBeInstanceOf(
      PhraseAsyncRequestError,
    );
  });

  it("does not retry a job upload after a transport failure with an unknown outcome", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      throw new Error("connection reset");
    };
    const client = new PhraseClient({
      platformApiToken: "personal-platform-token",
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      fetch,
      maxRetries: 3,
    });

    await expect(
      client.createJob({
        projectUid: "project-uid",
        filename: "catalog.json",
        sourceBytes: new TextEncoder().encode("{}"),
        targetLangs: ["fr"],
      }),
    ).rejects.toMatchObject({ mayHaveExecuted: true });
    expect(calls).toHaveLength(2);
  });

  it("marks an unreadable job-creation response as ambiguous", async () => {
    let uploads = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      uploads += 1;
      return new Response("not-json", { status: 201 });
    };
    const client = new PhraseClient({
      platformApiToken: "platform-token",
      region: "us",
      fetch,
    });

    await expect(
      client.createJob({
        projectUid: "project-uid",
        filename: "catalog.json",
        sourceBytes: new TextEncoder().encode("{}"),
        targetLangs: ["fr"],
      }),
    ).rejects.toMatchObject({ mayHaveExecuted: true });
    expect(uploads).toBe(1);
  });

  it("polls asynchronous work and honors Retry-After for safe reads", async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    let now = 1_000;
    let poll = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      poll += 1;
      if (poll === 1) return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      return new Response(
        JSON.stringify({ id: "import-42", asyncResponse: poll === 2 ? null : {} }),
        { status: 200 },
      );
    };
    const client = new PhraseClient({
      platformApiToken: "personal-platform-token",
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      fetch,
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    });

    await client.waitForAsyncRequest("import-42", { timeoutMs: 5_000, pollIntervalMs: 10 });

    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1_000, 10]);
  });

  it("starts target export asynchronously and returns downloaded bytes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const targetBytes = new TextEncoder().encode('{"greeting":"Bonjour"}');
    const targetBuffer = new ArrayBuffer(targetBytes.byteLength);
    new Uint8Array(targetBuffer).set(targetBytes);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url === "https://us.phrase.com/idm/oauth/token") {
        return new Response(JSON.stringify({ access_token: "short-lived-jwt", expires_in: 3600 }));
      }
      if (url.endsWith("/targetFile")) {
        return new Response(JSON.stringify({ asyncRequest: { id: "export-8" } }), { status: 202 });
      }
      if (url.endsWith("/async/export-8")) {
        return new Response(JSON.stringify({ id: "export-8", asyncResponse: {} }));
      }
      return new Response(targetBuffer, { status: 200 });
    };
    const client = new PhraseClient({
      platformApiToken: "personal-platform-token",
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      fetch,
    });

    const asyncRequestId = await client.startTargetDownload("project-uid", "job-fr");
    await client.waitForAsyncRequest(asyncRequestId);
    const downloaded = await client.downloadTargetFile("project-uid", "job-fr", asyncRequestId);

    expect(asyncRequestId).toBe("export-8");
    expect([...downloaded]).toEqual([...targetBytes]);
    expect(calls.map((call) => call.init?.method ?? "GET")).toEqual(["POST", "PUT", "GET", "GET"]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({});
  });

  it("rejects malformed and duplicate job input before calling Phrase", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error("fetch must not be called");
    };
    const client = new PhraseClient({
      platformApiToken: "personal-platform-token",
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      fetch,
    });
    const base = {
      projectUid: "project-uid",
      filename: "catalog.json",
      sourceBytes: new TextEncoder().encode("{}"),
    };

    await expect(client.createJob({ ...base, targetLangs: [] })).rejects.toThrow(
      "At least one non-empty Phrase target language is required",
    );
    await expect(client.createJob({ ...base, targetLangs: ["fr", "fr"] })).rejects.toThrow(
      "Phrase target languages must be unique",
    );
  });

  it("authenticates a service account with client credentials instead of token exchange", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url === "https://eu.phrase.com/idm/oauth/token") {
        return new Response(
          JSON.stringify({ access_token: "bot-jwt", token_type: "Bearer", expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ uid: "job-fr", targetLang: "fr", workflowLevel: 1, status: "NEW" }),
        { status: 200 },
      );
    };
    const client = new PhraseClient({
      serviceAccount: {
        clientId: "client-id",
        clientSecret: "client-secret",
        scope: "tms:default",
      },
      region: "eu",
      fetch,
    });

    await client.getJob("project-uid", "job-fr");
    await client.getJob("project-uid", "job-fr");

    expect(calls.map((call) => call.url)).toEqual([
      "https://eu.phrase.com/idm/oauth/token",
      "https://cloud.memsource.com/web/api2/v1/projects/project-uid/jobs/job-fr",
      "https://cloud.memsource.com/web/api2/v1/projects/project-uid/jobs/job-fr",
    ]);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.init?.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id",
      client_secret: "client-secret",
      scope: "tms:default",
    });
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe("Bearer bot-jwt");
  });

  it.each([
    [{}, /Platform API token or service account is required/],
    [
      {
        platformApiToken: "user-token",
        serviceAccount: { clientId: "id", clientSecret: "secret" },
      },
      /not both/,
    ],
    [
      { serviceAccount: { clientId: "id", clientSecret: "" } },
      /both a client ID and a client secret/,
    ],
    [{ serviceAccount: { clientId: "id", clientSecret: "secret", scope: " " } }, /scope/],
  ])("rejects invalid credentials %#", (credentials, expectedError) => {
    expect(() => new PhraseClient({ ...credentials, region: "eu" })).toThrow(expectedError);
  });

  it("does not expose service account secrets when OAuth rejects them", async () => {
    const client = new PhraseClient({
      serviceAccount: { clientId: "client-id", clientSecret: "do-not-leak-this-secret" },
      region: "us",
      fetch: async () => new Response("do-not-leak-this-secret", { status: 401 }),
    });

    const error = await client.getJob("project-uid", "job-fr").catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message:
        "Phrase Platform OAuth returned HTTP 401 for the service account credentials; check that the secret is current and stored under the name for its credential kind",
      status: 401,
    });
    expect(JSON.stringify(error)).not.toContain("do-not-leak-this-secret");
  });

  it("reports which credential kind it uses without detecting it from the value", () => {
    expect(new PhraseClient({ platformApiToken: "token", region: "eu" }).authMethod).toBe(
      "platform-api-token",
    );
    expect(
      new PhraseClient({
        serviceAccount: { clientId: "id", clientSecret: "secret" },
        region: "eu",
      }).authMethod,
    ).toBe("service-account");
  });

  it("does not expose the Platform API token when OAuth rejects it", async () => {
    const platformApiToken = "do-not-leak-this-token";
    const client = new PhraseClient({
      platformApiToken,
      oauthTokenUrl: "https://us.phrase.com/idm/oauth/token",
      fetch: async () => new Response(platformApiToken, { status: 401 }),
    });

    await expect(
      client.createJob({
        projectUid: "project-uid",
        filename: "catalog.json",
        sourceBytes: new TextEncoder().encode("{}"),
        targetLangs: ["fr"],
      }),
    ).rejects.toMatchObject({
      message:
        "Phrase Platform OAuth returned HTTP 401 for the Platform API token; check that the secret is current and stored under the name for its credential kind",
      status: 401,
    });
  });
});
