/**
 * The gateway's side. A gateway host's entry imports this module and the
 * sandbox's own program: it runs the program's Construction with
 * `__ALCHEMY_GATEWAY__` set, so every binding is built here, then answers
 * the sandbox's calls to the clients that Construction kept.
 *
 * Only a gateway's bundle imports this module.
 */
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { clients, decode, encode, TOKEN_HEADER, TOKEN_KEY } from "../Gateway.ts";
import { encodeRpcError, encodeRpcResponseStream, ErrorTag, RPC_STREAM_HEADER } from "../Rpc.ts";
import { reifyBoundConfigProvider } from "../Runtime.ts";
import { entrypointLayer, stackFromEnv } from "../Runtime/Bootstrap.ts";
import { unpackEnvValue } from "../RuntimeContext.ts";

const sameText = (a: string, b: string) => {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ (right[i % right.length] ?? 0);
  return diff === 0;
};

const reply = (value: unknown, status = 200) =>
  new Response(encode(value), { status, headers: { "content-type": "application/json" } });

/**
 * Serve a sandbox's program as its gateway. `env` is the gateway's
 * environment: the values the program's bindings bound at deploy.
 */
export const serve = (entrypoint: unknown) => {
  let construction: Promise<Context.Context<never>> | undefined;

  const construct = (env: Record<string, unknown>) => {
    globalThis.__ALCHEMY_RUNTIME__ = true;
    globalThis.__ALCHEMY_GATEWAY__ = true;
    // Bindings read their values from the process environment.
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    const layer = entrypointLayer(entrypoint).pipe(
      Layer.provideMerge(stackFromEnv),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
        ),
      ),
    ) as unknown as Layer.Layer<never>;
    // The scope lives as long as the gateway instance.
    return Effect.runPromise(
      Effect.flatMap(Scope.make(), (scope) => Layer.buildWithScope(layer, scope)),
    );
  };

  return async (request: Request, env: Record<string, unknown>): Promise<Response> => {
    const expected = unpackEnvValue<unknown>(env[TOKEN_KEY] as string | undefined);
    const secret =
      typeof expected === "string"
        ? expected
        : expected !== undefined
          ? String((expected as { value?: unknown }).value ?? "")
          : "";
    const presented = request.headers.get(TOKEN_HEADER);
    if (secret === "" || presented === null || !sameText(presented, secret)) {
      return new Response("forbidden", { status: 403 });
    }
    const services = await (construction ??= construct(env));
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!clients.has(key)) {
      return new Response(`the gateway holds no binding ${key}`, { status: 404 });
    }
    const { path, args } = decode(await request.text()) as {
      path: ReadonlyArray<string>;
      args?: ReadonlyArray<unknown>;
    };
    let target: any = clients.get(key);
    let owner: unknown;
    for (const name of path) {
      // A name like `constructor` or `__proto__` must not reach a prototype.
      if (target === null || target === undefined || !Object.hasOwn(target, name)) {
        return new Response(`${key} has no ${path.join(".")}`, { status: 404 });
      }
      owner = target;
      target = target[name];
    }
    const value = args === undefined ? target : Reflect.apply(target, owner, [...args]);
    const stream = (body: Stream.Stream<unknown, unknown, never>) =>
      new Response(
        Stream.toReadableStream(encodeRpcResponseStream(body) as Stream.Stream<Uint8Array>),
        { headers: { [RPC_STREAM_HEADER]: "ndjson" } },
      );
    const provide = Effect.provideContext(services);
    if (Stream.isStream(value) && !Effect.isEffect(value)) {
      return stream(Stream.provideContext(value, services) as Stream.Stream<unknown, unknown>);
    }
    const exit = await Effect.runPromiseExit(
      (Effect.isEffect(value) ? value : Effect.succeed(value)).pipe(provide) as Effect.Effect<
        unknown,
        unknown
      >,
    );
    if (Exit.isSuccess(exit)) {
      return Stream.isStream(exit.value)
        ? stream(Stream.provideContext(exit.value, services) as Stream.Stream<unknown, unknown>)
        : reply(exit.value ?? null);
    }
    const error = Cause.findErrorOption(exit.cause);
    return Option.isSome(error)
      ? reply({ _tag: ErrorTag, error: encodeRpcError(error.value) })
      : new Response(String(Cause.squash(exit.cause)), { status: 500 });
  };
};
