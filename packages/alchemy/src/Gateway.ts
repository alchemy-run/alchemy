/**
 * A sandbox's gateway: where its bindings run, holding the credentials the
 * sandbox must never see.
 *
 * The sandbox's program is not written for it. Its Construction runs three
 * times, and the phase decides what each binding does:
 *
 * 1. **At deploy**, bindings attach to the gateway instead of the sandbox
 *    (`Binding.Host`), and what they bind is stored on the gateway. The
 *    sandbox gets the plain values and none of the `Redacted` ones.
 * 2. **Inside the gateway**, bindings are built as on any host, and each
 *    client is kept under the binding's key.
 * 3. **Inside a sandbox**, a binding is not built: the program gets a client
 *    that calls the one the gateway kept.
 *
 * A host Layer (`Cloudflare.Workers.SandboxGateway`, …) deploys the gateway
 * and installs the phase on the sandbox's `RuntimeContext` with {@link make}.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Output from "./Output.ts";
import {
  asEffectOrStream,
  decodeRpcResponseStream,
  decodeRpcResult,
  encodeRpcResponseStream,
  RPC_STREAM_HEADER,
} from "./Rpc.ts";
import {
  CurrentRuntimeContext,
  RuntimeContext,
  unpackEnvValue,
  type BaseRuntimeContext,
  type GatewayContext,
} from "./RuntimeContext.ts";
import { Self } from "./Self.ts";

/** The gateway of the sandbox a Layer is provided on. */
export class Gateway extends Context.Service<
  Gateway,
  {
    /** The gateway's URL, as the sandbox reaches it. */
    readonly url: Effect.Effect<string>;
    /** The token that proves a request came from this sandbox. */
    readonly token: Effect.Effect<Redacted.Redacted<string>>;
  }
>()("Alchemy.Gateway") {}

/**
 * Names the argument that is streamed after the call: its index, or
 * `0.<field>` for a field of the first argument (a request's `Body`).
 */
export const STREAM_ARG_HEADER = "x-alchemy-gateway-stream-arg";

/** Where a call's one `Stream` argument is, if it has one. */
export const streamArgument = (args: ReadonlyArray<unknown>): string | undefined => {
  const index = args.findIndex((arg) => Stream.isStream(arg) && !Effect.isEffect(arg));
  if (index >= 0) return String(index);
  const first = args[0];
  if (first === null || typeof first !== "object") return undefined;
  const field = Object.keys(first).find((name) => Stream.isStream((first as any)[name]));
  return field === undefined ? undefined : `0.${field}`;
};

/** `args` with the argument at `location` replaced. */
export const withStreamArgument = (
  args: ReadonlyArray<unknown>,
  location: string,
  value: unknown,
): unknown[] => {
  const [index = "0", ...field] = location.split(".");
  return args.map((arg, at) =>
    at !== Number(index)
      ? arg
      : field.length === 0
        ? value
        : { ...(arg as object), [field.join(".")]: value },
  );
};

/**
 * A call as a request body. A `Stream` argument (an upload's body) is sent
 * after the call, as it is produced: the call is the first line, the
 * stream's chunks the rest.
 */
const requestBody = (path: ReadonlyArray<string>, args: ReadonlyArray<unknown> | undefined) => {
  const location = args === undefined ? undefined : streamArgument(args);
  if (args === undefined || location === undefined) {
    return HttpClientRequest.bodyText(
      encode({ path, ...(args === undefined ? {} : { args }) }),
      "application/json",
    );
  }
  const [index = "0", ...field] = location.split(".");
  const holder = args[Number(index)] as any;
  const body = (field.length === 0 ? holder : holder[field.join(".")]) as Stream.Stream<
    unknown,
    unknown
  >;
  const head = JSON.parse(encode({ path, args: withStreamArgument(args, location, null) }));
  return (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.setHeader(STREAM_ARG_HEADER, location),
      HttpClientRequest.bodyStream(
        encodeRpcResponseStream(Stream.concat(Stream.succeed(head), body)) as Stream.Stream<
          Uint8Array,
          never
        >,
        { contentType: "application/x-ndjson" },
      ),
    );
};

/** Names the field of a result that is streamed after it. */
export const STREAM_FIELD_HEADER = "x-alchemy-gateway-stream-field";

/** The header a sandbox proves itself to its gateway with. */
export const TOKEN_HEADER = "x-alchemy-gateway-token";
/** Where the gateway reads the token it expects. */
export const TOKEN_KEY = "ALCHEMY_GATEWAY_TOKEN";
/** Where a sandbox reads its gateway's URL and its token. */
export const SANDBOX_URL_KEY = "ALCHEMY_GATEWAY_URL";
export const SANDBOX_TOKEN_KEY = "ALCHEMY_GATEWAY_SANDBOX_TOKEN";

/** The clients the gateway's Construction built, by binding key. */
export const clients = new Map<string, unknown>();

/** An HTTP origin and the headers that authenticate a request to it. */
export interface Origin {
  /** The base URL, without a trailing slash. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The origins a gateway forwards to, by id. */
export const origins = new Map<string, Effect.Effect<Origin, unknown>>();

/** The path a gateway serves its {@link origins} under. */
export const PROXY_PATH = "/~proxy/";

/** What the gateway is serving as: set by its request handler. */
export const serving: { url: string; token: string } = { url: "", token: "" };

/**
 * An origin for something that speaks HTTP by itself: a CLI (`git`), an SDK
 * the binding does not wrap. A binding's client returns it.
 *
 * On an ordinary host it is `upstream`: the real URL and its credential. In
 * a sandbox's gateway it is the gateway's own URL and the sandbox's token,
 * and the gateway forwards requests under it to `upstream` with the real
 * credential. The sandbox only ever sees the second form.
 */
export const proxy = <E>(
  id: string,
  upstream: Effect.Effect<Origin, E>,
): Effect.Effect<Origin, E> => {
  if (!globalThis.__ALCHEMY_GATEWAY__) return upstream;
  // Registered while the binding is constructed, so every instance of the
  // gateway forwards it, whichever one answered the sandbox's first call.
  origins.set(id, upstream);
  return Effect.sync(() => ({
    url: `${serving.url}${PROXY_PATH}${encodeURIComponent(id)}`,
    headers: { [TOKEN_HEADER]: serving.token },
  }));
};

/** A gateway a host Layer deployed. */
export interface Deployed {
  /** The gateway resource, as the host bindings attach to. */
  readonly self: { readonly Type: string; readonly LogicalId: string };
  readonly url: Output.Output<string, never>;
  readonly token: Output.Output<Redacted.Redacted<string>, never>;
  /** Store a bound value in the gateway's environment. */
  readonly set: (key: string, output: Output.Output) => Effect.Effect<void>;
}

/** The sandbox program a gateway runs: the sandbox's own `main` and export. */
export const programOf = (sandbox: unknown) => {
  const props = (sandbox as { Props?: { main?: string; handler?: string } }).Props ?? {};
  return {
    // A URL (`import.meta.url`), an absolute path, or a path relative to the
    // project (a Worker's `main` is stored that way).
    main: props.main?.startsWith("file:")
      ? new URL(props.main).pathname
      : props.main === undefined || props.main.startsWith("/")
        ? (props.main ?? "")
        : `${process.cwd()}/${props.main}`,
    handler: props.handler ?? "default",
  };
};

const PROGRAM = "virtual:alchemy-gateway-program";

/**
 * A bundler plugin for a gateway host's entry: resolves its
 * `virtual:alchemy-gateway-program` import to the sandbox's program.
 */
export const programPlugin = (sandbox: unknown) => {
  const { main, handler } = programOf(sandbox);
  return {
    name: "alchemy:gateway-program",
    resolveId: (id: string) => (id === PROGRAM ? `\0${PROGRAM}` : null),
    load: (id: string) =>
      id === `\0${PROGRAM}`
        ? `export { ${handler} as default } from ${JSON.stringify(main)};`
        : null,
  };
};

/**
 * The logical id of a sandbox's gateway. Bindings name what they create
 * after their host, so it is unique to the sandbox.
 */
export const gatewayId = (sandboxId: string) => `${sandboxId}Gateway`;

/** A value a platform's `set` packed for its environment, as it was bound. */
const unpackBound = (packed: unknown): unknown => {
  // Some platforms keep `Redacted` around the packed string.
  const text = Redacted.isRedacted(packed) ? Redacted.value(packed) : packed;
  const value = typeof text === "string" ? unpackEnvValue<unknown>(text) : text;
  return Redacted.isRedacted(packed) && !Redacted.isRedacted(value) ? Redacted.make(value) : value;
};

const literal = <A>(value: A) => Output.literal(value) as unknown as Output.Output<A, never>;

/**
 * The body of a gateway host Layer. `deploy` runs at deploy only and
 * declares the gateway; in the gateway and in a sandbox it is skipped.
 */
export const make = <R>(
  deploy: Effect.Effect<Deployed, never, R>,
  options: {
    /** The gateway's resource type, as bindings see their host. */
    readonly type: string;
    /**
     * How this sandbox reaches the gateway, when not over the public
     * internet (a Worker calls a Worker through a service binding). Read on
     * each call; `undefined` uses the ambient `HttpClient`.
     */
    readonly client?: Effect.Effect<HttpClient.HttpClient | undefined>;
  },
) =>
  Effect.gen(function* () {
    // Every platform provides its Construction a RuntimeContext.
    const sandbox = yield* RuntimeContext as unknown as Effect.Effect<BaseRuntimeContext>;
    const client = yield* HttpClient.HttpClient;
    const deployed = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* deploy;
    // Bound before the phase is installed, so they land on the sandbox.
    const url = yield* Output.named(deployed?.url ?? literal(""), SANDBOX_URL_KEY).asEffect();
    // A platform that sets the token at the sandbox's boundary keeps it out
    // of the sandbox: the program sends an empty one, which is overwritten.
    const injected = sandbox.gatewayEgress === true;
    if (deployed !== undefined && injected) {
      const host = (yield* Self) as unknown as {
        bind: (id: string, data: unknown) => Effect.Effect<void>;
      };
      yield* host.bind("Gateway", { gateway: { url: deployed.url, token: deployed.token } });
    }
    const token = yield* Output.named(
      (injected ? undefined : deployed?.token) ?? literal(Redacted.make("")),
      SANDBOX_TOKEN_KEY,
    ).asEffect();

    if (deployed !== undefined) {
      const setOnSandbox = sandbox.set.bind(sandbox);
      const withoutSecrets = (output: Output.Output) =>
        // Platforms differ on an absent value, so a withheld secret is empty.
        output.pipe(Output.map((value) => (Redacted.isRedacted(value) ? "" : value)));
      // A Layer built before this one already bound its values onto the
      // sandbox: move them here, so Layer order never leaves a secret there.
      for (const [key, packed] of Object.entries(sandbox.env)) {
        if (key === SANDBOX_URL_KEY || key === SANDBOX_TOKEN_KEY) continue;
        // The platform already packed the value for its environment.
        const value = (packed as Output.Output).pipe(Output.map(unpackBound));
        yield* deployed.set(key, value);
        yield* setOnSandbox(key, withoutSecrets(value));
      }
      sandbox.gateway = {
        phase: "plan",
        self: deployed.self,
        set: Effect.fn(function* (key, output, options) {
          yield* deployed.set(key, output);
          // The sandbox reads plain values where the gateway does. A secret
          // reaches it only as the program's own `Config`.
          return yield* setOnSandbox(key, options?.sandbox ? output : withoutSecrets(output));
        }),
      };
    } else if (globalThis.__ALCHEMY_GATEWAY__) {
      // The program is the sandbox's, so its context reads the sandbox
      // platform's environment (a Worker's bindings, …). Here the values are
      // the gateway's, which its entry put in the process environment.
      sandbox.get = <T>(key: string) =>
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- bound values are read raw, never through Config (see unpackEnvValue)
        Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T);
      sandbox.gateway = {
        phase: "gateway",
        self: { Type: options.type, LogicalId: gatewayId(sandbox.id) },
        register: (key, built) => Effect.sync(() => void clients.set(key, built)),
      };
    } else {
      sandbox.gateway = {
        phase: "sandbox",
        call: (key, path, args) =>
          asEffectOrStream(
            Effect.gen(function* () {
              const response = yield* HttpClientRequest.post(
                `${(yield* url).replace(/\/+$/, "")}/${encodeURIComponent(key)}`,
              ).pipe(
                HttpClientRequest.setHeader(TOKEN_HEADER, Redacted.value(yield* token)),
                requestBody(path, args),
                ((yield* options.client ?? Effect.succeed(undefined)) ?? client).execute,
                // A gateway's hostname can take a few seconds to answer after
                // a deploy. A transport failure never reached the binding,
                // so sending the call again cannot run it twice.
                Effect.retry({
                  while: (error) => error.reason._tag === "TransportError",
                  schedule: Schedule.exponential("250 millis"),
                  times: 6,
                }),
                unreachable(key),
              );
              if (response.status !== 200) {
                return yield* Effect.die(
                  new GatewayError({
                    binding: key,
                    cause: `HTTP ${response.status}: ${yield* Effect.orElseSucceed(response.text, () => "")}`,
                  }),
                );
              }
              if (response.headers[RPC_STREAM_HEADER] !== undefined) {
                return decodeRpcResponseStream(response.stream) as Stream.Stream<unknown, unknown>;
              }
              const field = response.headers[STREAM_FIELD_HEADER];
              if (field !== undefined) {
                // The first line is the value; the rest is its stream field,
                // read as the caller consumes it. The response stays open
                // until that stream ends.
                const scope = Scope.makeUnsafe();
                const [head, rest] = yield* Stream.peel(
                  decodeRpcResponseStream(response.stream),
                  Sink.head(),
                ).pipe(Effect.provideService(Scope.Scope, scope), unreachable(key));
                return {
                  ...(Option.getOrUndefined(head) as object),
                  [field]: rest.pipe(Stream.onExit((exit) => Scope.close(scope, exit))),
                };
              }
              const text = yield* response.text.pipe(unreachable(key));
              return yield* decodeRpcResult(decode(text));
            }),
          ),
      };
    }
    return { url, token };
  });

/** The gateway could not be reached, or holds no such binding. */
export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly binding: string;
  readonly cause: unknown;
}> {}

/**
 * The gateway is part of the binding: failing to reach it is a defect, not
 * one of the binding's own errors.
 */
const unreachable =
  (binding: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    Effect.catch(effect, (cause) => Effect.die(new GatewayError({ binding, cause })));

const BYTES = "~alchemy/gateway/bytes";

/** JSON with bytes kept. A `Redacted` value never crosses: it encodes as `<redacted>`. */
const toBase64 = (bytes: Uint8Array) => {
  // In pieces: one `fromCharCode` call takes a bounded number of arguments.
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
};

/** JSON with bytes kept. A `Redacted` value never crosses: it encodes as `<redacted>`. */
export const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Uint8Array ? { _tag: BYTES, b64: toBase64(item) } : item,
  ) ?? "null";

export const decode = (text: string): unknown =>
  text === ""
    ? undefined
    : JSON.parse(text, (_key, item) =>
        item !== null && typeof item === "object" && item._tag === BYTES
          ? Uint8Array.from(atob(item.b64), (char) => char.charCodeAt(0))
          : item,
      );

/** Names one `Binding(...args)` call the same way in every phase. */
const keyOf = (id: string, args: ReadonlyArray<unknown>) =>
  `${id}(${args
    .map((arg, index) => {
      const logicalId = (arg as { LogicalId?: unknown } | undefined)?.LogicalId;
      if (typeof logicalId === "string") return logicalId;
      try {
        return JSON.stringify(arg) ?? String(index);
      } catch {
        return String(index);
      }
    })
    .join(",")})`;

/**
 * Called by `Binding.Service` around a binding's Construction. Without a
 * gateway it is `build(...args)`.
 */
export const bind = <A, E, R>(
  id: string,
  args: ReadonlyArray<unknown>,
  build: (...args: any[]) => Effect.Effect<A, E, R>,
  /** The binding configures its own host (a mount) and holds no credential. */
  local: boolean,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(CurrentRuntimeContext, (ctx) => {
    const gateway = ctx?.gateway;
    if (ctx === undefined || gateway === undefined) return build(...args);
    if (local) {
      return Effect.provideService(build(...args), RuntimeContext, derive(ctx, undefined));
    }
    if (gateway.phase === "plan") {
      // Everything the binding binds, `Config` included, is the gateway's.
      return Effect.provideService(
        build(...args),
        RuntimeContext,
        derive(ctx, { ...gateway, set: (key, output) => gateway.set(key, output) }),
      );
    }
    const key = keyOf(id, args);
    if (gateway.phase === "gateway") {
      return Effect.tap(build(...args), (client) => gateway.register(key, client));
    }
    return Effect.succeed(remoteClient(gateway.call, key, []) as A);
  });

/** The same context with another view of the gateway. */
const derive = (ctx: BaseRuntimeContext, gateway: GatewayContext | undefined): BaseRuntimeContext =>
  Object.create(ctx, { gateway: { value: gateway, enumerable: true } });

type Call = (
  key: string,
  path: ReadonlyArray<string>,
  args: ReadonlyArray<unknown> | undefined,
) => Effect.Effect<unknown, unknown>;

/**
 * A stand-in for a client the gateway holds. Calling it, calling a method
 * on it, or yielding one of its Effect members runs the same thing there.
 */
const remoteClient = (call: Call, key: string, path: ReadonlyArray<string>): unknown => {
  const read = call(key, path, undefined);
  // Effect's protocol is answered by `read` itself: its methods are bound to
  // it, so `yield*` and `pipe` run the call and never see this stand-in.
  const protocol = (prop: string | symbol) => {
    const member = Reflect.get(read, prop, read);
    return typeof member === "function" ? member.bind(read) : member;
  };
  return new Proxy((..._args: unknown[]) => undefined, {
    apply: (_target, _self, args) => call(key, path, args),
    has: (_target, prop) => Reflect.has(read, prop),
    get: (_target, prop) =>
      // Not a thenable: `await` and Promise resolution must not call it.
      prop === "then"
        ? undefined
        : typeof prop === "symbol" || Reflect.has(read, prop)
          ? protocol(prop)
          : remoteClient(call, key, [...path, prop]),
  });
};
