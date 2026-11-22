import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ConnectService,
  ServiceUrlMissing,
  connectServiceEnvKeys,
  type ConnectServiceClient,
  type ConnectableService,
} from "./ConnectService.ts";
import { isRenderHost } from "./RenderBindings.ts";

/** Normalize Render public or private `host:port` service addresses into a base HTTP URL. */
export const normalizeServiceUrl = (raw: string | undefined, slug: string): string => {
  if (raw && (raw.startsWith("http://") || raw.startsWith("https://"))) {
    return raw;
  }
  if (raw && raw.length > 0) {
    return `http://${raw}`;
  }
  return `http://${slug}`;
};

const readConfigString = (key: string): Effect.Effect<string | undefined> =>
  Config.String(key).pipe(Config.option, Effect.orDie, Effect.map(Option.getOrUndefined));

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A> | A,
): Effect.Effect<A, never, RuntimeContext> =>
  Output.isOutput(output)
    ? output.bind(key).pipe(Effect.flatMap((effect) => effect))
    : Effect.succeed(output);

const resolveString = (
  key: string,
  output: Output.Output<string> | string,
  resourceName: string,
): Effect.Effect<string, ServiceUrlMissing, RuntimeContext> =>
  Effect.gen(function* () {
    const rt = yield* CurrentRuntimeContext;
    if (rt) {
      const stored = yield* rt.get<string>(sanitizeKey(key));
      if (typeof stored === "string" && stored.length > 0) {
        return stored;
      }
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const evaluated = yield* runtimeOutput(key, output);
        if (typeof evaluated === "string" && evaluated.length > 0) {
          return evaluated;
        }
      }
    }
    const configured = yield* readConfigString(key);
    if (typeof configured === "string" && configured.length > 0) {
      return configured;
    }
    return yield* new ServiceUrlMissing({ resourceName });
  });

/**
 * HTTP implementation of {@link ConnectService}.
 *
 * **Example:** Provide `ConnectServiceHttp` to service-calling code
 * ```typescript
 * Effect.gen(function* () {
 *   const upstream = yield* Render.ConnectService(api);
 *   return yield* upstream.url;
 * }).pipe(Effect.provide(Render.ConnectServiceHttp));
 * ```
 *
 * @layer
 * @product Compute
 * @provides Render.ConnectService
 */
export const ConnectServiceHttp = Layer.effect(
  ConnectService,
  Effect.succeed(
    Effect.fn(function* (service: ConnectableService) {
      const keys = connectServiceEnvKeys(service);
      const resourceName = service.LogicalId;

      const rawUrl: Output.Output<string | undefined> | string | undefined = service.url;
      const rawSlug: Output.Output<string> | string = service.slug;

      const urlOutput: Output.Output<string> | string = Output.isOutput(rawUrl)
        ? Output.isOutput(rawSlug)
          ? Output.map(
              Output.all(rawUrl, rawSlug),
              ([u, s]: readonly [string | undefined, string]) => normalizeServiceUrl(u, s),
            )
          : Output.map(rawUrl, (u: string | undefined) =>
              normalizeServiceUrl(u, typeof rawSlug === "string" ? rawSlug : resourceName),
            )
        : Output.isOutput(rawSlug)
          ? Output.map(rawSlug, (s: string) =>
              normalizeServiceUrl(typeof rawUrl === "string" ? rawUrl : undefined, s),
            )
          : normalizeServiceUrl(
              typeof rawUrl === "string" ? rawUrl : undefined,
              typeof rawSlug === "string" ? rawSlug : resourceName,
            );

      const slugOutput: Output.Output<string> | string = rawSlug;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRenderHost(host)) {
          yield* host.bind`${service}`({
            env: {
              [keys.url]: urlOutput,
              [keys.slug]: slugOutput,
            },
          });
        } else {
          const rt = yield* CurrentRuntimeContext;
          if (rt) {
            yield* rt.set(sanitizeKey(keys.url), Output.asOutput(urlOutput));
            yield* rt.set(sanitizeKey(keys.slug), Output.asOutput(slugOutput));
          }
        }
      }

      const url = resolveString(keys.url, urlOutput, resourceName);
      const slug = resolveString(keys.slug, slugOutput, resourceName);

      return {
        url,
        slug,
        fetch: (request) =>
          Effect.gen(function* () {
            const baseUrl = yield* url;
            const http = yield* HttpClient.HttpClient;
            const req =
              request.url.startsWith("http://") || request.url.startsWith("https://")
                ? request
                : HttpClientRequest.prependUrl(request, baseUrl);
            return yield* http.execute(req);
          }),
      } satisfies ConnectServiceClient;
    }),
  ),
);
