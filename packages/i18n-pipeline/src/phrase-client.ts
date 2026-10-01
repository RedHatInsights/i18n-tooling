import { createHash } from "node:crypto";

export type PhraseRegion = "eu" | "us";

/** Phrase Platform Service Account credentials (OAuth 2.0 client credentials). */
export interface PhraseServiceAccountCredentials {
  clientId: string;
  clientSecret: string;
  /** Space-separated, product-prefixed scopes; omit for the account's full configured scope. */
  scope?: string;
}

/** Provide exactly one of `platformApiToken` (a user's token) or `serviceAccount`. */
export interface PhraseClientOptions {
  platformApiToken?: string;
  serviceAccount?: PhraseServiceAccountCredentials;
  oauthTokenUrl?: string;
  apiBaseUrl?: string;
  region?: PhraseRegion;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
  /** Per-request timeout; an upload that times out is treated as possibly executed. */
  requestTimeoutMs?: number;
}

export function phraseEndpoints(region: PhraseRegion): {
  oauthTokenUrl: string;
  apiBaseUrl: string;
} {
  const host = region === "us" ? "us.cloud.memsource.com" : "cloud.memsource.com";
  const platformHost = region === "us" ? "us.phrase.com" : "eu.phrase.com";
  return {
    oauthTokenUrl: `https://${platformHost}/idm/oauth/token`,
    apiBaseUrl: `https://${host}/web`,
  };
}

export interface CreatePhraseJobInput {
  projectUid: string;
  filename: string;
  sourceBytes: Uint8Array;
  targetLangs: string[];
  importSettingsUid?: string;
  useProjectFileImportSettings?: boolean;
}

export interface PhraseImportSettingsSummary {
  uid: string;
  name: string;
}

export interface PhraseImportSettingsRecord extends PhraseImportSettingsSummary {
  fileImportSettings: Record<string, unknown>;
}

export interface PhraseImportSettingsPage {
  content: PhraseImportSettingsSummary[];
  pageNumber: number;
  totalPages: number;
}

export interface PhraseJobPart {
  uid: string;
  targetLang: string;
  workflowLevel: number;
  lastWorkflowLevel?: number;
  imported?: boolean;
  status?: string;
  importStatus?: {
    status: "RUNNING" | "ERROR" | "OK";
    errorMessage?: string | null;
  };
}

export interface PhraseJobCreation {
  asyncRequest: { id: string; action?: string };
  jobs: PhraseJobPart[];
  unsupportedFiles: string[];
  warnings: unknown[];
}

export interface PhraseAsyncRequest {
  id: string;
  action?: string;
  asyncResponse: null | {
    errorCode?: string;
    errorDesc?: string;
  };
}

export class PhraseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly mayHaveExecuted = false,
  ) {
    super(message);
    this.name = "PhraseApiError";
  }
}

/** Platform OAuth refused the credentials; the message names the credential kind, never its value. */
export class PhraseAuthError extends PhraseApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "PhraseAuthError";
  }
}

export type PhraseAuthMethod = "service-account" | "platform-api-token";

export class PhraseTransportError extends Error {
  constructor(
    message: string,
    readonly mayHaveExecuted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PhraseTransportError";
  }
}

export class PhraseAsyncRequestError extends Error {
  constructor(
    readonly asyncRequestId: string,
    readonly errorCode?: string,
  ) {
    super(errorCode ? `Phrase async request failed (${errorCode})` : "Phrase async request failed");
    this.name = "PhraseAsyncRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function retryAfterMilliseconds(response: Response, now: number): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function encodeFilename(filename: string): string {
  return encodeURIComponent(filename)
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

export class PhraseClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;
  private readonly oauthTokenUrl: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private cachedAccessToken?: { value: string; expiresAt: number };
  /** Which credential kind this client authenticates with; chosen by the caller, not detected. */
  readonly authMethod: PhraseAuthMethod;

  constructor(private readonly options: PhraseClientOptions) {
    const { platformApiToken, serviceAccount } = options;
    if (platformApiToken !== undefined && serviceAccount !== undefined) {
      throw new TypeError(
        "Provide either a Phrase Platform API token or a service account, not both",
      );
    }
    if (serviceAccount !== undefined) {
      if (
        !nonEmptyString(serviceAccount.clientId) ||
        !nonEmptyString(serviceAccount.clientSecret)
      ) {
        throw new TypeError("A Phrase service account needs both a client ID and a client secret");
      }
      if (serviceAccount.scope !== undefined && !nonEmptyString(serviceAccount.scope)) {
        throw new TypeError("Phrase service account scope must be a non-empty string");
      }
    } else if (!nonEmptyString(platformApiToken)) {
      throw new TypeError("A Phrase Platform API token or service account is required");
    }
    const regionalEndpoints = options.region ? phraseEndpoints(options.region) : undefined;
    const oauthTokenUrl = options.oauthTokenUrl ?? regionalEndpoints?.oauthTokenUrl;
    if (!nonEmptyString(oauthTokenUrl)) {
      throw new TypeError("Provide a Phrase region or Platform OAuth token URL");
    }
    this.oauthTokenUrl = oauthTokenUrl;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiBaseUrl = (
      options.apiBaseUrl ??
      regionalEndpoints?.apiBaseUrl ??
      "https://cloud.memsource.com/web"
    ).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRetries = options.maxRetries ?? 2;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.authMethod = serviceAccount ? "service-account" : "platform-api-token";
  }

  async getProjectImportSettings(projectUid: string): Promise<Record<string, unknown>> {
    if (!nonEmptyString(projectUid)) throw new TypeError("Phrase project UID is required");
    const response = await this.apiRequest(
      `/api2/v1/projects/${encodeURIComponent(projectUid)}/importSettings`,
      { method: "GET", headers: { Accept: "application/json" } },
      true,
    );
    const value: unknown = await response.json();
    if (!isRecord(value)) {
      throw new PhraseApiError("Phrase returned invalid project import settings", response.status);
    }
    return value;
  }

  async listImportSettings(pageNumber: number, pageSize = 50): Promise<PhraseImportSettingsPage> {
    if (!Number.isInteger(pageNumber) || pageNumber < 0) {
      throw new TypeError("Phrase import-settings page number must be a non-negative integer");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new TypeError("Phrase import-settings page size must be between 1 and 50");
    }
    const query = new URLSearchParams({
      pageNumber: String(pageNumber),
      pageSize: String(pageSize),
    });
    const response = await this.apiRequest(
      `/api2/v1/importSettings?${query}`,
      { method: "GET", headers: { Accept: "application/json" } },
      true,
    );
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.content)) {
      throw new PhraseApiError("Phrase returned invalid import-settings list", response.status);
    }
    const content = value.content.map((entry) => {
      if (!isRecord(entry) || !nonEmptyString(entry.uid) || !nonEmptyString(entry.name)) {
        throw new PhraseApiError(
          "Phrase returned an invalid import-settings summary",
          response.status,
        );
      }
      return { uid: entry.uid, name: entry.name };
    });
    const totalPages =
      typeof value.totalPages === "number" && Number.isInteger(value.totalPages)
        ? value.totalPages
        : pageNumber + (content.length === pageSize ? 2 : 1);
    return { content, pageNumber, totalPages };
  }

  async getImportSettings(uid: string): Promise<PhraseImportSettingsRecord> {
    if (!nonEmptyString(uid)) throw new TypeError("Phrase import-settings UID is required");
    const response = await this.apiRequest(
      `/api2/v1/importSettings/${encodeURIComponent(uid)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      true,
    );
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      !nonEmptyString(value.uid) ||
      !nonEmptyString(value.name) ||
      !isRecord(value.fileImportSettings)
    ) {
      throw new PhraseApiError("Phrase returned invalid import settings", response.status);
    }
    return {
      uid: value.uid,
      name: value.name,
      fileImportSettings: value.fileImportSettings,
    };
  }

  async createImportSettings(
    name: string,
    fileImportSettings: Record<string, unknown>,
  ): Promise<PhraseImportSettingsRecord> {
    if (!nonEmptyString(name)) throw new TypeError("Phrase import-settings name is required");
    const response = await this.apiRequest(
      "/api2/v1/importSettings",
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ name, fileImportSettings }),
      },
      false,
      true,
    );
    const value: unknown = await response.json();
    if (!isRecord(value) || !nonEmptyString(value.uid)) {
      throw new PhraseApiError(
        "Phrase returned an invalid import-settings creation response",
        response.status,
        true,
      );
    }
    return this.getImportSettings(value.uid);
  }

  async ensureJsonIcuImportSettings(
    projectUid: string,
    name: string,
  ): Promise<{ uid: string; name: string; created: boolean }> {
    if (!nonEmptyString(name)) throw new TypeError("Phrase import-settings name is required");
    const projectSettings = await this.getProjectImportSettings(projectUid);
    const fileImportSettings: Record<string, unknown> = {
      ...projectSettings,
      fileFormat: "json",
      json: {
        ...(isRecord(projectSettings.json) ? projectSettings.json : {}),
        icuSubFilter: true,
      },
    };
    const fingerprint = createHash("sha256")
      .update(stableJson({ projectUid, fileImportSettings }))
      .digest("hex")
      .slice(0, 12);
    const profileName = `${name} ${fingerprint}`;
    if (profileName.length > 255) {
      throw new TypeError("Phrase import-settings name must be at most 243 characters");
    }

    const findMatchingSettings = async (): Promise<{
      matching?: PhraseImportSettingsRecord;
      nameCollision: boolean;
    }> => {
      let pageNumber = 0;
      let totalPages = 1;
      let nameCollision = false;
      while (pageNumber < totalPages) {
        const page = await this.listImportSettings(pageNumber);
        totalPages = page.totalPages;
        for (const summary of page.content) {
          let settings: PhraseImportSettingsRecord;
          try {
            settings = await this.getImportSettings(summary.uid);
          } catch (error) {
            if (error instanceof PhraseApiError && error.status === 404) continue;
            throw error;
          }
          if (stableJson(settings.fileImportSettings) === stableJson(fileImportSettings)) {
            return { matching: settings, nameCollision };
          }
          if (settings.name === profileName) nameCollision = true;
        }
        pageNumber += 1;
      }
      return { nameCollision };
    };

    const existing = await findMatchingSettings();
    if (existing.matching) {
      return { uid: existing.matching.uid, name: existing.matching.name, created: false };
    }
    if (existing.nameCollision) {
      throw new Error(
        `Phrase import-settings profile "${profileName}" exists with different settings`,
      );
    }

    let created: PhraseImportSettingsRecord;
    try {
      created = await this.createImportSettings(profileName, fileImportSettings);
    } catch (error) {
      // A lost POST response may still have created the record. Find it before allowing a retry.
      const recovered = await findMatchingSettings();
      if (recovered.matching) {
        return { uid: recovered.matching.uid, name: recovered.matching.name, created: false };
      }
      throw error;
    }
    if (stableJson(created.fileImportSettings) !== stableJson(fileImportSettings)) {
      throw new Error(
        `Phrase import-settings profile "${profileName}" did not retain the requested settings`,
      );
    }
    return { uid: created.uid, name: created.name, created: true };
  }

  async createJob(input: CreatePhraseJobInput): Promise<PhraseJobCreation> {
    if (!nonEmptyString(input.projectUid)) throw new TypeError("Phrase project UID is required");
    if (!nonEmptyString(input.filename)) throw new TypeError("Source filename is required");
    if (!input.sourceBytes.byteLength) throw new TypeError("Source catalog must not be empty");
    if (!input.targetLangs.length || input.targetLangs.some((locale) => !nonEmptyString(locale))) {
      throw new TypeError("At least one non-empty Phrase target language is required");
    }
    if (new Set(input.targetLangs).size !== input.targetLangs.length) {
      throw new TypeError("Phrase target languages must be unique");
    }
    if (input.importSettingsUid && input.useProjectFileImportSettings) {
      throw new TypeError("Choose either importSettingsUid or useProjectFileImportSettings");
    }

    const metadata: Record<string, unknown> = { targetLangs: input.targetLangs };
    if (input.importSettingsUid) metadata.importSettings = { uid: input.importSettingsUid };
    if (input.useProjectFileImportSettings) metadata.useProjectFileImportSettings = true;
    const headers = new Headers({
      Accept: "application/json",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeFilename(input.filename)}`,
      "Content-Type": "application/octet-stream",
      Memsource: JSON.stringify(metadata),
    });
    const sourceBuffer = new ArrayBuffer(input.sourceBytes.byteLength);
    new Uint8Array(sourceBuffer).set(input.sourceBytes);
    const body = new Blob([sourceBuffer], { type: "application/octet-stream" });
    const response = await this.apiRequest(
      `/api2/v1/projects/${encodeURIComponent(input.projectUid)}/jobs`,
      { method: "POST", headers, body },
      false,
      true,
    );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new PhraseApiError(
        "Phrase returned an unreadable job-creation response",
        response.status,
        true,
      );
    }
    if (
      !isRecord(value) ||
      !isRecord(value.asyncRequest) ||
      !nonEmptyString(value.asyncRequest.id)
    ) {
      throw new PhraseApiError(
        "Phrase returned an invalid job-creation response",
        response.status,
        true,
      );
    }
    const jobs = Array.isArray(value.jobs) ? value.jobs.filter(isPhraseJobPart) : [];
    return {
      asyncRequest: {
        id: value.asyncRequest.id,
        ...(typeof value.asyncRequest.action === "string"
          ? { action: value.asyncRequest.action }
          : {}),
      },
      jobs,
      unsupportedFiles: Array.isArray(value.unsupportedFiles)
        ? value.unsupportedFiles.filter((file): file is string => typeof file === "string")
        : [],
      warnings: Array.isArray(value.warnings) ? value.warnings : [],
    };
  }

  async getAsyncRequest(asyncRequestId: string): Promise<PhraseAsyncRequest> {
    if (!nonEmptyString(asyncRequestId)) throw new TypeError("Phrase async request ID is required");
    const response = await this.apiRequest(
      `/api2/v1/async/${encodeURIComponent(asyncRequestId)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      true,
    );
    const value: unknown = await response.json();
    if (!isRecord(value) || !nonEmptyString(value.id)) {
      throw new PhraseApiError(
        "Phrase returned an invalid async-request response",
        response.status,
      );
    }
    const asyncResponse = value.asyncResponse;
    if (asyncResponse !== null && !isRecord(asyncResponse)) {
      throw new PhraseApiError("Phrase returned an invalid async response", response.status);
    }
    return {
      id: value.id,
      ...(typeof value.action === "string" ? { action: value.action } : {}),
      asyncResponse:
        asyncResponse === null
          ? null
          : {
              ...(typeof asyncResponse.errorCode === "string"
                ? { errorCode: asyncResponse.errorCode }
                : {}),
              ...(typeof asyncResponse.errorDesc === "string"
                ? { errorDesc: asyncResponse.errorDesc }
                : {}),
            },
    };
  }

  async getJob(projectUid: string, jobUid: string): Promise<PhraseJobPart> {
    const response = await this.apiRequest(
      `/api2/v1/projects/${encodeURIComponent(projectUid)}/jobs/${encodeURIComponent(jobUid)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      true,
    );
    const value: unknown = await response.json();
    if (!isPhraseJobPart(value)) {
      throw new PhraseApiError("Phrase returned an invalid job response", response.status);
    }
    return value;
  }

  async startTargetDownload(projectUid: string, jobUid: string): Promise<string> {
    const response = await this.apiRequest(
      `/api2/v3/projects/${encodeURIComponent(projectUid)}/jobs/${encodeURIComponent(jobUid)}/targetFile`,
      {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      false,
      true,
    );
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      !isRecord(value.asyncRequest) ||
      !nonEmptyString(value.asyncRequest.id)
    ) {
      throw new PhraseApiError(
        "Phrase returned an invalid target-download response",
        response.status,
        true,
      );
    }
    return value.asyncRequest.id;
  }

  async downloadTargetFile(
    projectUid: string,
    jobUid: string,
    asyncRequestId: string,
  ): Promise<Uint8Array> {
    const response = await this.apiRequest(
      `/api2/v2/projects/${encodeURIComponent(projectUid)}/jobs/${encodeURIComponent(jobUid)}/downloadTargetFile/${encodeURIComponent(asyncRequestId)}`,
      { method: "GET", headers: { Accept: "application/octet-stream" } },
      true,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async waitForAsyncRequest(
    asyncRequestId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const deadline = this.now() + timeoutMs;
    while (true) {
      const request = await this.getAsyncRequest(asyncRequestId);
      if (request.asyncResponse !== null) {
        if (request.asyncResponse.errorCode || request.asyncResponse.errorDesc) {
          throw new PhraseAsyncRequestError(asyncRequestId, request.asyncResponse.errorCode);
        }
        return;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for Phrase request ${asyncRequestId}`);
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  private async apiRequest(
    path: string,
    init: RequestInit,
    retryable: boolean,
    mayHaveExecuted = false,
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const canRetry = retryable && method === "GET";
    let token = await this.accessToken();
    let refreshed = false;
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          headers: new Headers({
            ...Object.fromEntries(new Headers(init.headers)),
            Authorization: `Bearer ${token}`,
          }),
        });
      } catch (error) {
        if (canRetry && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          attempt += 1;
          continue;
        }
        throw new PhraseTransportError(
          mayHaveExecuted ? "Phrase request outcome is unknown" : "Could not reach Phrase API",
          mayHaveExecuted,
          { cause: error },
        );
      }

      if (response.status === 401 && !refreshed && method === "GET") {
        this.cachedAccessToken = undefined;
        token = await this.accessToken();
        refreshed = true;
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        canRetry &&
        attempt < this.maxRetries
      ) {
        const delay = retryAfterMilliseconds(response, this.now()) ?? 500 * 2 ** attempt;
        await this.sleep(delay);
        attempt += 1;
        continue;
      }
      if (!response.ok) {
        throw new PhraseApiError(
          `Phrase API returned HTTP ${response.status}`,
          response.status,
          mayHaveExecuted && response.status >= 500,
        );
      }
      return response;
    }
  }

  /** Service accounts use client credentials; user tokens use Platform token exchange. */
  private tokenRequestBody(): URLSearchParams {
    const { serviceAccount } = this.options;
    if (serviceAccount) {
      return new URLSearchParams({
        grant_type: "client_credentials",
        client_id: serviceAccount.clientId,
        client_secret: serviceAccount.clientSecret,
        ...(serviceAccount.scope ? { scope: serviceAccount.scope } : {}),
      });
    }
    return new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: this.options.platformApiToken ?? "",
      subject_token_type: "urn:phrase:params:oauth:token-type:api_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  }

  private async accessToken(): Promise<string> {
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt - 60_000 > this.now()) {
      return this.cachedAccessToken.value;
    }
    const body = this.tokenRequestBody();
    let response: Response;
    try {
      response = await this.fetcher(this.oauthTokenUrl, {
        method: "POST",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
    } catch (error) {
      throw new PhraseTransportError("Could not reach Phrase Platform OAuth", false, {
        cause: error,
      });
    }
    if (!response.ok) {
      const credential =
        this.authMethod === "service-account"
          ? "service account credentials"
          : "Platform API token";
      const hint = [400, 401, 403].includes(response.status)
        ? "; check that the secret is current and stored under the name for its credential kind"
        : "";
      throw new PhraseAuthError(
        `Phrase Platform OAuth returned HTTP ${response.status} for the ${credential}${hint}`,
        response.status,
      );
    }
    const value: unknown = await response.json();
    if (!isRecord(value) || !nonEmptyString(value.access_token)) {
      throw new PhraseApiError(
        "Phrase Platform OAuth returned an invalid token response",
        response.status,
      );
    }
    const expiresIn = typeof value.expires_in === "number" ? value.expires_in : 300;
    this.cachedAccessToken = {
      value: value.access_token,
      expiresAt: this.now() + Math.max(0, expiresIn) * 1000,
    };
    return value.access_token;
  }
}

function isPhraseJobPart(value: unknown): value is PhraseJobPart {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.uid) ||
    !nonEmptyString(value.targetLang) ||
    typeof value.workflowLevel !== "number"
  ) {
    return false;
  }
  if (value.lastWorkflowLevel !== undefined && typeof value.lastWorkflowLevel !== "number")
    return false;
  if (value.imported !== undefined && typeof value.imported !== "boolean") return false;
  if (value.status !== undefined && typeof value.status !== "string") return false;
  if (value.importStatus !== undefined) {
    if (
      !isRecord(value.importStatus) ||
      !["RUNNING", "ERROR", "OK"].includes(String(value.importStatus.status)) ||
      (value.importStatus.errorMessage !== undefined &&
        value.importStatus.errorMessage !== null &&
        typeof value.importStatus.errorMessage !== "string")
    ) {
      return false;
    }
  }
  return true;
}
