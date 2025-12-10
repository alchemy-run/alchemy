import { APIConnectionError, Cloudflare, type APIError } from "cloudflare";
import {
  isRequestOptions,
  type APIPromise,
  type RequestOptions,
} from "cloudflare/core";
import type { ErrorData } from "cloudflare/resources";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { Config } from "effect";

export const CLOUDFLARE_BASE_URL = Config.string("CLOUDFLARE_BASE_URL").pipe(
  Config.option,
);
export const CLOUDFLARE_API_TOKEN = Config.string("CLOUDFLARE_API_TOKEN").pipe(
  Config.option,
);
export const CLOUDFLARE_API_KEY = Config.string("CLOUDFLARE_API_KEY").pipe(
  Config.option,
);
export const CLOUDFLARE_API_EMAIL = Config.string("CLOUDFLARE_API_EMAIL").pipe(
  Config.option,
);

export class CloudflareApi extends Effect.Service<CloudflareApi>()(
  "cloudflare/api",
  {
    effect: Effect.fn(function* (options?: {
      baseUrl?: string;
      apiToken?: string;
      apiKey?: string;
      apiEmail?: string;
    }) {
      return createRecursiveProxy(
        new Cloudflare({
          baseURL:
            options?.baseUrl ??
            (yield* CLOUDFLARE_BASE_URL).pipe(Option.getOrUndefined),
          apiToken:
            options?.apiToken ??
            (yield* CLOUDFLARE_API_TOKEN).pipe(Option.getOrUndefined),
          apiKey:
            options?.apiKey ??
            (yield* CLOUDFLARE_API_KEY).pipe(Option.getOrUndefined),
          apiEmail:
            options?.apiEmail ??
            (yield* CLOUDFLARE_API_EMAIL).pipe(Option.getOrUndefined),
        }),
      );
    }),
  },
) {}

export class CloudflareApiError extends Data.Error<{
  _tag:
    | "Connection"
    | "BadRequest"
    | "Authentication"
    | "PermissionDenied"
    | "NotFound"
    | "Conflict"
    | "UnprocessableEntity"
    | "RateLimit"
    | "InternalServerError"
    | "Unknown";
  message: string;
  errors: ErrorData[];
  cause: APIError;
}> {
  static from(cause: APIError): CloudflareApiError {
    const error = new CloudflareApiError({
      _tag: CloudflareApiError.getTag(cause),
      message: cause.message,
      errors: cause.errors,
      cause: cause,
    });
    return error;
  }

  private static getTag(error: APIError): CloudflareApiError["_tag"] {
    if (error instanceof APIConnectionError) {
      return "Connection";
    }
    switch (error.status) {
      case 400:
        return "BadRequest";
      case 401:
        return "Authentication";
      case 403:
        return "PermissionDenied";
      case 404:
        return "NotFound";
      case 409:
        return "Conflict";
      case 422:
        return "UnprocessableEntity";
      case 429:
        return "RateLimit";
      case 500:
        return "InternalServerError";
      default:
        return "Unknown";
    }
  }
}

type ToEffect<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? (
        ...args: Parameters<T[K]>
      ) => Effect.Effect<UnwrapAPIPromise<ReturnType<T[K]>>, CloudflareApiError>
    : T[K] extends Record<string, any>
      ? ToEffect<T[K]>
      : T[K];
};

type UnwrapAPIPromise<T> = T extends APIPromise<infer U> ? U : never;

const createRecursiveProxy = <T extends object>(target: T): ToEffect<T> => {
  return new Proxy(target as any, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return Effect.fnUntraced(function* (...args: any[]) {
          return yield* Effect.tryPromise({
            try: async (signal) => {
              let modifiedArgs: any[];
              if (isRequestOptions(args[args.length - 1])) {
                const options = args[args.length - 1] as RequestOptions;
                modifiedArgs = [
                  ...args.slice(0, -1),
                  {
                    ...options,
                    signal: options?.signal
                      ? AbortSignal.any([signal, options.signal])
                      : signal,
                  },
                ];
              } else {
                modifiedArgs = [...args, { signal }];
              }
              const result = await value.apply(target, modifiedArgs);
              return result;
            },
            catch: (cause) => {
              const error = CloudflareApiError.from(cause as APIError);
              return error;
            },
          });
        });
      }
      return createRecursiveProxy(value);
    },
  });
};
