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
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Output from "./Output.ts";
import {
  asEffectOrStream,
  decodeRpcResponseStream,
  decodeRpcResult,
  RPC_STREAM_HEADER,
} from "./Rpc.ts";
import {
  CurrentRuntimeContext,
  RuntimeContext,
  type BaseRuntimeContext,
  type GatewayContext,
} from "./RuntimeContext.ts";

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

/** The header a sandbox proves itself to its gateway with. */
export const TOKEN_HEADER = "x-alchemy-gateway-token";
/** Where the gateway reads the token it expects. */
export const TOKEN_KEY = "ALCHEMY_GATEWAY_TOKEN";
/** Where a sandbox reads its gateway's URL and its token. */
export const SANDBOX_URL_KEY = "ALCHEMY_GATEWAY_URL";
export const SANDBOX_TOKEN_KEY = "ALCHEMY_GATEWAY_SANDBOX_TOKEN";

/** The clients the gateway's Construction built, by binding key. */
export const clients = new Map<string, unknown>();

/** A gateway a host Layer deployed. */
export interface Deployed {
  /** The gateway resource, as the host bindings attach to. */
  readonly self: { readonly Type: string; readonly LogicalId: string };
  readonly url: Output.Output<string, never>;
  readonly token: Output.Output<Redacted.Redacted<string>, never>;
  /** Store a bound value in the gateway's environment. */
  readonly set: (key: string, output: Output.Output) => Effect.Effect<void>;
}

const literal = <A>(value: A) => Output.literal(value) as unknown as Output.Output<A, never>;

/**
 * The body of a gateway host Layer. `deploy` runs at deploy only and
 * declares the gateway; in the gateway and in a sandbox it is skipped.
 */
export const make = <R>(deploy: Effect.Effect<Deployed, never, R>) =>
  Effect.gen(function* () {
    // Every platform provides its Construction a RuntimeContext.
    const sandbox = yield* RuntimeContext as unknown as Effect.Effect<BaseRuntimeContext>;
    const client = yield* HttpClient.HttpClient;
    const deployed = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* deploy;
    // Bound before the phase is installed, so they land on the sandbox.
    const url = yield* Output.named(deployed?.url ?? literal(""), SANDBOX_URL_KEY).asEffect();
    const token = yield* Output.named(
      deployed?.token ?? literal(Redacted.make("")),
      SANDBOX_TOKEN_KEY,
    ).asEffect();

    if (deployed !== undefined) {
      const setOnSandbox = sandbox.set.bind(sandbox);
      const withoutSecrets = (output: Output.Output) =>
        // Platforms differ on an absent value, so a withheld secret is empty.
        output.pipe(Output.map((value) => (Redacted.isRedacted(value) ? "" : value)));
      // A Layer built before this one already bound its values onto the
      // sandbox: move them here, so Layer order never leaves a secret there.
      for (const [key, value] of Object.entries(sandbox.env)) {
        if (key === SANDBOX_URL_KEY || key === SANDBOX_TOKEN_KEY) continue;
        yield* deployed.set(key, value as Output.Output);
        sandbox.env[key] = withoutSecrets(value as Output.Output);
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
      sandbox.gateway = {
        phase: "gateway",
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
                HttpClientRequest.bodyText(
                  encode({ path, ...(args === undefined ? {} : { args }) }),
                  "application/json",
                ),
                client.execute,
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
export const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Uint8Array ? { _tag: BYTES, b64: btoa(String.fromCharCode(...item)) } : item,
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
  return new Proxy((..._args: unknown[]) => undefined, {
    apply: (_target, _self, args) => call(key, path, args),
    has: (_target, prop) => Reflect.has(read, prop),
    get: (_target, prop) =>
      // Not a thenable: `await` and Promise resolution must not call it.
      prop === "then"
        ? undefined
        : typeof prop === "symbol" || Reflect.has(read, prop)
          ? Reflect.get(read, prop, read)
          : remoteClient(call, key, [...path, prop]),
  });
};
