import { alchemy } from "../alchemy.ts";
import type { Secret } from "../secret.ts";
import { safeFetch } from "../util/safe-fetch.ts";

/**
 * Options for Sentry API requests
 */
export interface SentryApiOptions {
  /**
   * Auth token to use (overrides environment variable)
   */
  authToken?: Secret;
}

/**
 * Minimal API client using raw fetch
 */
export class SentryApi {
  /** Base URL for API */
  readonly baseUrl: string;

  /** Auth token */
  readonly authToken: Secret;

  /**
   * Create a new API client
   *
   * @param options API options
   */
  constructor(options: SentryApiOptions = {}) {
    this.baseUrl = "https://sentry.io/api/0";
    this.authToken =
      options.authToken ?? alchemy.secret(process.env.SENTRY_AUTH_TOKEN || "");

    if (!this.authToken.unencrypted) {
      throw new Error("SENTRY_AUTH_TOKEN environment variable is required");
    }
  }

  /**
   * Make a request to the API
   *
   * @param path API path (without base URL)
   * @param init Fetch init options
   * @returns Raw Response object from fetch
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.authToken.unencrypted}`,
    };

    if (init.headers) {
      const initHeaders = init.headers as Record<string, string>;
      Object.keys(initHeaders).forEach((key) => {
        headers[key] = initHeaders[key];
      });
    }

    if (init.body instanceof FormData) {
      delete headers["Content-Type"];
    }

    return safeFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  /**
   * Helper for GET requests
   */
  async get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "GET" });
  }

  /**
   * Helper for POST requests
   */
  async post(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestBody = body instanceof FormData ? body : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "POST", body: requestBody });
  }

  /**
   * Helper for PUT requests
   */
  async put(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    const requestBody = body instanceof FormData ? body : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "PUT", body: requestBody });
  }

  /**
   * Helper for DELETE requests
   */
  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "DELETE" });
  }
}
