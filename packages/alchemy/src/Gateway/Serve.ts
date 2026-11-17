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
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import {
  clients,
  decode,
  encode,
  origins,
  PROXY_PATH,
  serving,
  STREAM_ARG_HEADER,
  STREAM_FIELD_HEADER,
  TOKEN_HEADER,
  TOKEN_KEY,
  withStreamArgument,
} from "../Gateway.ts";
import {
  decodeRpcResponseStream,
  encodeRpcError,
  encodeRpcResponseStream,
  ErrorTag,
  RPC_STREAM_HEADER,
} from "../Rpc.ts";
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

interface Call {
  readonly path: ReadonlyArray<string>;
  readonly args?: ReadonlyArray<unknown>;
}

/**
 * Read a call. With a streamed argument, the call is the body's first line
 * and the rest is that argument's stream, read as the binding consumes it.
 */
const readCall = async (request: Request): Promise<Call> => {
  const location = request.headers.get(STREAM_ARG_HEADER);
  if (location === null || request.body === null) return decode(await request.text()) as Call;
  const body = request.body;
  const scope = Scope.makeUnsafe();
  const [head, rest] = await Effect.runPromise(
    Stream.peel(
      decodeRpcResponseStream(
        Stream.fromReadableStream({ evaluate: () => body, onError: (cause) => cause }),
      ),
      Sink.head(),
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  // Through the gateway's own codec, so bytes in the other arguments survive.
  const call = decode(JSON.stringify(Option.getOrUndefined(head))) as Required<Call>;
  return {
    path: call.path,
    args: withStreamArgument(
      call.args,
      location,
      rest.pipe(Stream.onExit((exit) => Scope.close(scope, exit))),
    ),
  };
};

/** Headers that describe one hop, or the encoding `fetch` already undid. */
const HOP = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  TOKEN_HEADER,
];

/**
 * Forward a request under {@link PROXY_PATH} to the origin a binding
 * registered, with that origin's credential, streaming both bodies.
 */
const forward = async (request: Request, url: URL, services: Context.Context<never>) => {
  const [id = "", ...rest] = url.pathname.slice(PROXY_PATH.length).split("/");
  const upstream = origins.get(decodeURIComponent(id));
  if (upstream === undefined) {
    return new Response(`the gateway forwards no origin ${id}`, { status: 404 });
  }
  const exit = await Effect.runPromiseExit(upstream.pipe(Effect.provideContext(services)));
  if (!Exit.isSuccess(exit)) {
    return new Response(String(Cause.squash(exit.cause)), { status: 502 });
  }
  const headers = new Headers(request.headers);
  // The request's own encoding is forwarded as sent; only the hop's is dropped.
  const encoding = headers.get("content-encoding");
  for (const name of HOP) headers.delete(name);
  if (encoding !== null) headers.set("content-encoding", encoding);
  for (const [name, value] of Object.entries(exit.value.headers)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(`${exit.value.url}/${rest.join("/")}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  const answered = new Headers(response.headers);
  for (const name of HOP) answered.delete(name);
  return new Response(response.body, { status: response.status, headers: answered });
};

/**
 * Serve a sandbox's program as its gateway. `env` is the gateway's
 * environment: the values the program's bindings bound at deploy.
 */
export const serve = (
  entrypoint: unknown,
  options?: {
    /** Platform services the program's Construction may use (a Node host's file system, …). */
    readonly services?: Layer.Layer<any>;
    /** The gateway's public URL, when the request's own URL is not it. */
    readonly url?: (request: Request) => string;
  },
) => {
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
      Layer.provideMerge(options?.services ?? Layer.empty),
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

  // A failure answers with its cause, so the sandbox's defect names it.
  return (request: Request, env: Record<string, unknown>): Promise<Response> =>
    handle(request, env).catch((cause) => {
      // A failed Construction is tried again on the next request.
      construction = undefined;
      return new Response(`the gateway failed: ${cause?.stack ?? cause}`, { status: 500 });
    });

  async function handle(request: Request, env: Record<string, unknown>): Promise<Response> {
    // A load balancer's health check carries no token and learns nothing.
    if (request.method === "GET" && new URL(request.url).pathname === "/") {
      return new Response("ok");
    }
    const expected = unpackEnvValue<unknown>(env[TOKEN_KEY] as string | undefined);
    const secret = Redacted.isRedacted(expected)
      ? String(Redacted.value(expected))
      : typeof expected === "string"
        ? expected
        : "";
    const presented = request.headers.get(TOKEN_HEADER);
    if (secret === "" || presented === null || !sameText(presented, secret)) {
      return new Response("forbidden", { status: 403 });
    }
    const services = await (construction ??= construct(env));
    const url = new URL(request.url);
    serving.url = options?.url?.(request) ?? url.origin;
    serving.token = secret;
    if (url.pathname.startsWith(PROXY_PATH)) {
      return forward(request, url, services);
    }
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!clients.has(key)) {
      return new Response(`the gateway holds no binding ${key}`, { status: 404 });
    }
    const { path, args } = await readCall(request);
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
      const result = exit.value;
      if (Stream.isStream(result)) {
        return stream(Stream.provideContext(result, services) as Stream.Stream<unknown, unknown>);
      }
      // A result with one streamed field (an object's body): the value
      // first, then the field's chunks, as they are produced.
      const field =
        result !== null && typeof result === "object"
          ? Object.keys(result).find((name) => Stream.isStream((result as any)[name]))
          : undefined;
      if (field !== undefined) {
        const { [field]: body, ...head } = result as Record<string, unknown>;
        return new Response(
          Stream.toReadableStream(
            encodeRpcResponseStream(
              Stream.concat(
                Stream.succeed(JSON.parse(encode(head))),
                Stream.provideContext(body as Stream.Stream<unknown, unknown, never>, services),
              ),
            ) as Stream.Stream<Uint8Array>,
          ),
          { headers: { [STREAM_FIELD_HEADER]: field } },
        );
      }
      return reply(result ?? null);
    }
    const error = Cause.findErrorOption(exit.cause);
    return Option.isSome(error)
      ? reply({ _tag: ErrorTag, error: encodeRpcError(error.value) })
      : new Response(String(Cause.squash(exit.cause)), { status: 500 });
  }
};
