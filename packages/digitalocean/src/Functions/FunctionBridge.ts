/**
 * The OpenWhisk entry of a bundled `DigitalOcean.Functions.Function`. The
 * generated entry imports this module and the user's `main`, and exports
 * `main(args)`: OpenWhisk calls it with the web request in `__ow_*`
 * arguments and the function's environment as default parameters.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { safeHttpEffect } from "alchemy/Http";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import { StackContext } from "alchemy/StackContext";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { FunctionRuntimeContext } from "./FunctionRuntimeContext.ts";

type OpenWhiskArgs = Record<string, unknown> & {
  __ow_method?: string;
  __ow_headers?: Record<string, string>;
  __ow_path?: string;
  __ow_query?: string;
  __ow_body?: string;
};

type OpenWhiskResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const TEXT = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|$)/;

const isText = (contentType: string | null) => TEXT.test((contentType ?? "").split(";")[0]!);

// Default parameters carry the function's environment. They arrive with
// every call, so copy them into `process.env` once.
const applyEnvironment = (args: OpenWhiskArgs) => {
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith("__ow_") || typeof value !== "string") continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

const toRequest = (args: OpenWhiskArgs): Request => {
  const headers = new Headers(args.__ow_headers ?? {});
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const query = args.__ow_query ? `?${args.__ow_query}` : "";
  const url = `https://${host}${args.__ow_path || "/"}${query}`;
  const method = (args.__ow_method ?? "get").toUpperCase();
  const raw = args.__ow_body;
  const body =
    method === "GET" || method === "HEAD" || raw === undefined || raw === ""
      ? undefined
      : isText(headers.get("content-type"))
        ? raw
        : Buffer.from(raw, "base64");
  return new Request(url, { method, headers, body });
};

const toResult = async (response: Response): Promise<OpenWhiskResult> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: isText(response.headers.get("content-type"))
      ? new TextDecoder().decode(bytes)
      : Buffer.from(bytes).toString("base64"),
  };
};

/** `main(args)` for an Effect program: builds its layers once per instance. */
export const makeEffectMain = (entrypoint: unknown) => {
  const instanceScope = Scope.makeUnsafe();
  const tag = Self as unknown as Context.Service<never, { RuntimeContext: FunctionRuntimeContext }>;
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    SecureRandom.layerWebCrypto,
    Layer.effect(
      ConfigProvider.ConfigProvider,
      Effect.sync(() =>
        reifyBoundConfigProvider(
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
            ConfigProvider.fromEnv(),
          ),
          process.env,
        ),
      ),
    ),
    Layer.effect(
      StackContext,
      Effect.sync(() => ({
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the bridge's own process facts, set by the deploy
        name: process.env.ALCHEMY_STACK_NAME ?? "DigitalOceanFunction",
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the bridge's own process facts, set by the deploy
        stage: process.env.ALCHEMY_STAGE ?? "runtime",
        bindings: {},
        resources: {},
        actions: {},
      })),
    ),
  );
  const build = Layer.buildWithScope(
    makeEntrypointLayer(tag, entrypoint).pipe(Layer.provideMerge(platform)),
    instanceScope,
  ).pipe(
    Effect.flatMap((built) =>
      tag.pipe(
        Effect.flatMap((host) =>
          host.RuntimeContext.handler.pipe(
            Effect.map((served) => ({ ...served, runtime: host.RuntimeContext, built })),
          ),
        ),
        Effect.provideContext(built),
      ),
    ),
    Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Infinity : 0)),
    Effect.runSync,
  );

  return async (args: OpenWhiskArgs): Promise<OpenWhiskResult> => {
    applyEnvironment(args);
    const request = toRequest(args);
    const response = await Effect.gen(function* () {
      const served = yield* build;
      const services = Context.mergeAll(
        served.built,
        served.context,
        Context.make(RuntimeContext, served.runtime),
        Context.make(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );
      const context = yield* Effect.context<never>();
      const res = yield* safeHttpEffect(served.handler).pipe(Effect.provideContext(services));
      return HttpServerResponse.toWeb(res, { withoutBody: request.method === "HEAD", context });
    }).pipe(Effect.scoped, Effect.runPromise);
    return toResult(response);
  };
};

/** `main(args)` for an async module exporting `fetch(request, env)`. */
export const makeAsyncMain = (exported: unknown) => {
  const handler =
    typeof exported === "function"
      ? exported
      : (exported as { fetch?: unknown } | undefined)?.fetch;
  return async (args: OpenWhiskArgs): Promise<OpenWhiskResult> => {
    applyEnvironment(args);
    if (typeof handler !== "function") {
      return { statusCode: 500, headers: {}, body: "main exports no fetch handler" };
    }
    const response = (await handler(toRequest(args), process.env)) as Response;
    return toResult(response);
  };
};
