import type { Secret } from "../secret.js";

/**
 * Options for Upstash API requests
 */
export interface UpstashApiOptions {
  /**
   * API key to use (overrides environment variable)
   */
  apiKey?: Secret;

  /**
   * Email to use (overrides environment variable)
   */
  email?: string;
}

/**
 * Minimal API client using raw fetch
 */
export class UpstashApi {
  /** Base URL for API */
  readonly baseUrl: string;

  /** API key */
  readonly apiKey: string;

  /** Email */
  readonly email: string;

  /**
   * Create a new API client
   *
   * @param options API options
   */
  constructor(options: UpstashApiOptions = {}) {
    this.baseUrl = "https://api.upstash.com/v2";
    this.apiKey =
      options.apiKey?.unencrypted ?? process.env.UPSTASH_API_KEY ?? "";
    this.email = options.email ?? process.env.UPSTASH_EMAIL ?? "";

    if (!this.apiKey) {
      throw new Error("UPSTASH_API_KEY environment variable is required");
    }

    if (!this.email) {
      throw new Error("UPSTASH_EMAIL environment variable is required");
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
      Authorization: `Basic ${btoa(`${this.email}:${this.apiKey}`)}`,
    };

    if (init.headers) {
      const initHeaders = init.headers as Record<string, string>;
      Object.keys(initHeaders).forEach((key) => {
        headers[key] = initHeaders[key];
      });
    }

    return fetch(`${this.baseUrl}${path}`, {
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
    return this.fetch(path, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Helper for DELETE requests
   */
  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "DELETE" });
  }
}
