// @ts-nocheck

/* {IMPORTS} */

export class PlanetScaleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly url: string;
  readonly method: string;

  constructor(props: {
    code: string;
    message: string;
    status: number;
    url: string;
    method: string;
  }) {
    super(
      `A request to the PlanetScale API failed (${props.status} ${props.code}): ${props.message}`,
    );
    this.code = props.code;
    this.status = props.status;
    this.url = props.url;
    this.method = props.method;
  }
}

export interface PlanetScaleProps {
  /**
   * The base URL of the PlanetScale API. Defaults to https://api.planetscale.com/v1.
   */
  baseUrl?: string;
  /**
   * The ID of the service token to use for authentication. Defaults to the value of the PLANETSCALE_SERVICE_TOKEN_ID environment variable.
   */
  serviceTokenId?: Secret;
  /**
   * The secret of the service token to use for authentication. Defaults to the value of the PLANETSCALE_SERVICE_TOKEN environment variable.
   */
  serviceToken?: Secret;
  /**
   * The API key to use for authentication. Defaults to the value of the PLANETSCALE_API_TOKEN environment variable.
   * @deprecated Use serviceTokenId and serviceToken instead.
   */
  apiKey?: Secret;
  /**
   * The organization to use for authentication. Defaults to the value of the PLANETSCALE_ORGANIZATION or PLANETSCALE_ORG_ID environment variable.
   */
  organizationId?: string;
}

type ResultType = "json" | "full";

type RequestType<TParams, TResult extends ResultType> = Omit<TParams, "url"> & {
  /**
   * The type of response to return.
   * If "json", the response JSON will be returned and any errors will be thrown.
   * If "response", the entire response will be returned regardless of errors.
   * @default "json"
   */
  result?: TResult;
};

type ResponseType<T, TResult extends ResultType> = TResult extends "json"
  ? T
  :
      | { status: number; data: T; error: null; response: Response }
      | {
          status: number;
          data: null;
          error: PlanetScaleError;
          response: Response;
        };

export class PlanetScaleClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(props: PlanetScaleProps = {}) {
    this.baseUrl = props.baseUrl ?? "https://api.planetscale.com/v1";
    if (props.apiKey) {
      this.token = props.apiKey.unencrypted;
    } else if (props.serviceTokenId && props.serviceToken) {
      this.token = `${props.serviceTokenId.unencrypted}:${props.serviceToken.unencrypted}`;
    } else if (process.env.PLANETSCALE_API_TOKEN) {
      this.token = process.env.PLANETSCALE_API_TOKEN;
    } else if (
      process.env.PLANETSCALE_SERVICE_TOKEN_ID &&
      process.env.PLANETSCALE_SERVICE_TOKEN
    ) {
      this.token = `${process.env.PLANETSCALE_SERVICE_TOKEN_ID}:${process.env.PLANETSCALE_SERVICE_TOKEN}`;
    } else {
      throw new Error(
        "No authentication token provided for PlanetScale. Please provide an API key, service token ID and secret, or set the PLANETSCALE_SERVICE_TOKEN_ID and PLANETSCALE_SERVICE_TOKEN environment variables.",
      );
    }
  }

  async request<T, TResult extends ResultType = "json">(input: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    path: `/${string}`;
    params?: {
      body?: Record<string, unknown>;
      query?: Record<string, string | number | boolean>;
      path?: Record<string, string>;
      result?: TResult;
    };
  }): Promise<ResponseType<T, TResult>> {
    const url = formatURL({
      url: this.baseUrl + input.path,
      path: input.params?.path,
      query: input.params?.query,
    });
    const res = await fetch(url, {
      method: input.method,
      headers: {
        Authorization: this.token,
        ...(input.params?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.params?.body
        ? { body: JSON.stringify(input.params.body) }
        : {}),
    });
    if (!res.ok) {
      const json = (await res.json()) as { code: string; message: string };
      const error = new PlanetScaleError({
        code: json.code,
        message: json.message,
        status: res.status,
        url,
        method: input.method,
      });
      if (input.params?.result === "full") {
        return {
          status: res.status,
          data: null,
          error,
          response: res,
        } as ResponseType<T, TResult>;
      }
      throw error;
    }
    const json = res.status === 204 ? null : ((await res.json()) as T);
    return (
      input.params?.result === "full"
        ? { status: res.status, data: json, error: null, response: res }
        : json
    ) as ResponseType<T, TResult>;
  }

  /* {ENDPOINTS} */
}

const formatURL = (input: {
  url: string;
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}) => {
  const url = new URL(
    input.url.replaceAll(/{(\w+)}/g, (_, key) => {
      if (!input.path?.[key]) {
        throw new Error(`Missing required parameter: ${key}`);
      }
      return input.path[key];
    }),
  );
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      url.searchParams.set(key, value.toString());
    }
  }
  return url.toString();
};
