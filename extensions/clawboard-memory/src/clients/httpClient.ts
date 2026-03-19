import { URL } from "node:url";
import type { PluginLogger } from "../../api.js";
import { resolveEnvBackedValue } from "../config/env.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import { createComponentLogger } from "../utils/logger.js";
import { retry } from "../utils/retry.js";
import { safeJsonParse } from "../utils/validation.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type EndpointConfig = {
  path?: string;
  method?: HttpMethod;
};

type HttpClientRetry = ClawboardMemoryPluginSettings["clawboard"]["retry"];
type HttpClientAuth = ClawboardMemoryPluginSettings["clawboard"]["auth"];

export class ApiHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody?: string;

  constructor(params: { message: string; status: number; url: string; responseBody?: string }) {
    super(params.message);
    this.name = "ApiHttpError";
    this.status = params.status;
    this.url = params.url;
    this.responseBody = params.responseBody;
  }
}

export type JsonHttpClientConfig = {
  name: string;
  baseUrl?: string;
  timeoutMs: number;
  retry: HttpClientRetry;
  auth: HttpClientAuth;
  logger: PluginLogger;
  env?: NodeJS.ProcessEnv;
};

export type JsonHttpRequest = {
  endpoint: EndpointConfig;
  pathParams?: Record<string, string | number | undefined>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
};

export class JsonHttpClient {
  private readonly logger: PluginLogger;

  constructor(private readonly config: JsonHttpClientConfig) {
    this.logger = createComponentLogger(config.logger, config.name);
  }

  async requestJson(request: JsonHttpRequest): Promise<unknown> {
    const baseUrl = this.config.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error(`${this.config.name} baseUrl is not configured`);
    }
    const path = request.endpoint.path?.trim();
    if (!path) {
      throw new Error(`${this.config.name} endpoint path is not configured`);
    }

    const method = (request.endpoint.method ?? "GET").toUpperCase() as HttpMethod;
    const url = this.buildUrl(baseUrl, path, request.pathParams, request.query);
    const headers = this.buildHeaders(request.headers);

    return await retry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
          const response = await fetch(url, {
            method,
            headers,
            body:
              request.body !== undefined && method !== "GET" && method !== "DELETE"
                ? JSON.stringify(request.body)
                : undefined,
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            throw new ApiHttpError({
              message: `${this.config.name} request failed (${response.status} ${response.statusText})`,
              status: response.status,
              url,
              responseBody: text,
            });
          }
          if (!text.trim()) {
            return {};
          }
          return safeJsonParse<unknown>(text) ?? text;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        maxAttempts: this.config.retry.maxAttempts,
        baseDelayMs: this.config.retry.baseDelayMs,
        shouldRetry: (error) => {
          if (error instanceof ApiHttpError) {
            return error.status === 429 || error.status >= 500;
          }
          return true;
        },
      },
    );
  }

  private buildUrl(
    baseUrl: string,
    pathTemplate: string,
    pathParams?: Record<string, string | number | undefined>,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    let resolvedPath = pathTemplate;
    for (const [key, value] of Object.entries(pathParams ?? {})) {
      resolvedPath = resolvedPath.replaceAll(`{${key}}`, encodeURIComponent(String(value ?? "")));
    }
    const url = new URL(resolvedPath, ensureTrailingSlash(baseUrl));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Headers {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      headers.set(key, value);
    }

    const authValue = resolveEnvBackedValue({
      explicitValue: this.config.auth.value,
      envName: this.config.auth.valueEnv,
      env: this.config.env,
    });

    if (!authValue || this.config.auth.mode === "none") {
      return headers;
    }

    if (this.config.auth.mode === "bearer") {
      headers.set("Authorization", `Bearer ${authValue}`);
      return headers;
    }

    const headerName =
      this.config.auth.headerName?.trim() ||
      (this.config.auth.mode === "apiKey" ? "x-api-key" : "Authorization");
    const prefix = this.config.auth.prefix?.trim();
    headers.set(headerName, prefix ? `${prefix} ${authValue}` : authValue);
    return headers;
  }
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
