import type { Secret } from "../secret.ts";
import { createClient } from "../util/api/client/client.gen.ts";
import type { ClientOptions } from "../util/api/client/types.gen.ts";
import { createConfig } from "../util/api/client/utils.gen.ts";
import { ClickhouseClient } from "./api/sdk.gen.ts";

/**
 * Options for Neon API requests
 */
export interface ClickhouseApiOptions {
  /**
   * The key ID for the Clickhouse API
   */
  keyId?: string | Secret<string>;

  /**
   * The secret for the Clickhouse API
   */
  secret?: string | Secret<string>;
}

export class ClickhouseError extends Error {
  status: number;
  method: string;
  url: string;
  code: string;

  constructor(props: {
    error: {
      status?: number;
      error?: string;
    };
    request: Request;
    response: Response;
  }) {
    const { status, error } = props.error;
    super(
      `A request to the Clickhouse API failed (${props.response.status}): ${error}`,
    );
    this.status = props.response.status;
    this.method = props.request.method;
    this.url = props.request.url;
    this.code = status?.toString() ?? "";
    Object.assign(this, props.error);
  }
}

/**
 * Create a ClickhouseApi instance with environment variable fallback
 * @param options API options
 * @returns ClickhouseApi instance
 */
export function createClickhouseApi(
  options: Partial<ClickhouseApiOptions> = {},
): ClickhouseClient {
  const keyId = options?.keyId ?? process.env.CLICKHOUSE_KEY_ID;
  const secret = options?.secret ?? process.env.CLICKHOUSE_KEY_SECRET;

  const client = createClient(
    createConfig<ClientOptions>({
      baseUrl: "https://api.clickhouse.cloud",
      throwOnError: true,
      headers: {
        Authorization: `Basic ${btoa(`${keyId}:${secret}`)}`,
      },
    }),
  );
  client.interceptors.error.use((error, response, request, options) => {
    if (options.throwOnError !== false) {
      throw new ClickhouseError({
        error: error as {
          status?: number;
          error?: string;
        },
        request,
        response,
      });
    }
    return error;
  });
  return new ClickhouseClient({
    client,
  });
}
