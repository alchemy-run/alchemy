import type { Secret } from "../secret.ts";
import { createClient } from "../util/api/client/client.gen.ts";
import type { ClientOptions } from "../util/api/client/types.gen.ts";
import { createConfig } from "../util/api/client/utils.gen.ts";
import { NeonClient } from "./api/sdk.gen.ts";
import type { GeneralError } from "./api/types.gen.ts";

/**
 * Options for Neon API requests
 */
export interface NeonApiOptions {
  /**
   * Base URL for Neon API
   * @default https://console.neon.tech/api/v2
   */
  baseUrl?: string;

  /**
   * API Key to use (overrides NEON_API_KEY env var)
   */
  apiKey?: Secret;
}

export class NeonError extends Error {
  status: number;
  method: string;
  url: string;
  code: string;

  constructor(props: {
    error: GeneralError;
    request: Request;
    response: Response;
  }) {
    const { code, message, ...rest } = props.error;
    super(
      `A request to the Neon API failed (${props.response.status}): ${message}`,
    );
    this.status = props.response.status;
    this.method = props.request.method;
    this.url = props.request.url;
    this.code = code;
    Object.assign(this, rest);
  }
}

/**
 * Create a NeonApi instance with environment variable fallback
 * @param options API options
 * @returns NeonApi instance
 */
export function createNeonApi(
  options: Partial<NeonApiOptions> = {},
): NeonClient {
  const apiKey = options.apiKey?.unencrypted ?? process.env.NEON_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Neon API key is required. Set NEON_API_KEY environment variable or provide apiKey option.",
    );
  }
  const client = createClient(
    createConfig<ClientOptions>({
      baseUrl: options.baseUrl ?? "https://console.neon.tech/api/v2",
      throwOnError: true,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }),
  );
  client.interceptors.error.use((error, response, request, options) => {
    if (options.throwOnError !== false) {
      throw new NeonError({
        error: error as GeneralError,
        request,
        response,
      });
    }
    return error;
  });
  return new NeonClient({
    client,
  });
}
