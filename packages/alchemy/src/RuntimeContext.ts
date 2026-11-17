import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { HttpEffect } from "./Http.ts";
import type { Output } from "./Output.ts";

export interface BaseRuntimeContext {
  Type: string;
  id: string;
  env: Record<string, any>;
  /**
   * Read a value by its (already-canonical) key. The key is used verbatim;
   * callers must {@link sanitizeKey} first. See {@link sanitizeKey}.
   */
  get<T>(key: string): Effect.Effect<T | undefined>;
  /**
   * Store an output under the given (already-canonical) key, returning the key.
   * The key is used verbatim; callers must {@link sanitizeKey} first.
   */
  set(id: string, output: Output): Effect.Effect<string>;
  exports?: Effect.Effect<Record<string, any>>;
  serve?<Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ): Effect.Effect<void, never, Req>;
  /**
   * Serve even when the impl shape has no `fetch` handler and no RPC
   * methods. Set by runtimes whose served handler carries routes of its
   * own — e.g. a runtime that routes Durable Object calls itself, so a
   * worker that only hosts Durable Objects still serves.
   */
  alwaysServe?: boolean;
  shape?: () => Record<string, unknown>;
  /** additional services to provide to the plan  */
  planServices?: Layer.Layer<any>;
  /**
   * Services the host provides its init in every phase, built over the
   * instance (e.g. a Cloudflare Worker's `WebhookHost`), so user code
   * doesn't provide them itself.
   */
  hostServices?: Layer.Layer<any, never, any>;
  /**
   * Telemetry exporter Layer registered during init via
   * `Telemetry.layer(...)` / `Telemetry.layerOtlp(...)` (see Telemetry.ts).
   * The runtime bridges build it into every event's request scope,
   * overriding the env-driven default.
   */
  telemetry?: Layer.Layer<never, any, any>;
  /**
   * Set during init by providing the `Workers.InputGate` Layer
   * (`alchemy/Workers`): the Durable Object bridge gives each instance an
   * input gate.
   */
  inputGate?: boolean;
  /**
   * Set during Construction by a sandbox gateway Layer (see `Gateway.ts`):
   * every binding of this host is built with the gateway as its host, and
   * the sandbox gets a client that calls it there.
   */
  gateway?: GatewayContext;
  /**
   * Set by a sandbox platform whose network policy can add a header to
   * requests leaving the sandbox. Its gateway is then bound onto it
   * (`{ gateway: { url, token } }`): the platform allows the gateway's host
   * and sets the token at the boundary, so the token never enters the
   * sandbox.
   */
  gatewayEgress?: boolean;
  /**
   * Set by a platform whose host runs code that is not trusted (an agent's
   * sandbox). A binding may not put a secret in such a host: its deploy
   * fails unless the host has a gateway, or opts in with
   * `Gateway.Unprotected`.
   */
  sandbox?: boolean;
  /**
   * Set on the context one binding is built with when what it binds is not
   * checked: a mount, which configures the sandbox itself.
   */
  trusted?: boolean;
  /** The host's own context, on a context one binding is built with. */
  root?: BaseRuntimeContext;
  /** Set by `Gateway.Unprotected`: bindings may keep their secrets in this sandbox. */
  unprotected?: boolean;
  /** Set by `Gateway.only`: the bindings (by id) that run in the gateway. */
  gatewayScope?: ReadonlySet<string>;
  /** Which binding bound each value (by key), kept during Construction. */
  boundBy?: Map<string, string>;
  /** What a gateway took over from this host (by key), as it was bound. */
  adopted?: Map<string, Output>;
  /**
   * Mint an OIDC ID token for `audience`, signed by the host's platform
   * (a Fly Machine's `/.fly/api`). Present only on hosts whose platform
   * issues them. Bindings exchange it with a cloud's STS instead of
   * holding a key Alchemy created.
   */
  oidcToken?: (audience: string) => Effect.Effect<Redacted.Redacted<string>, OidcTokenError>;
}

/**
 * A sandbox's gateway, as the phase a program's Construction is running in
 * sees it. The same program runs three times: at deploy, inside the gateway,
 * and inside each sandbox.
 */
export type GatewayContext =
  | {
      /** At deploy: bindings attach to the gateway, and their values are stored on it. */
      readonly phase: "plan";
      /** The gateway, as the host bindings attach to. */
      readonly self: { readonly Type: string; readonly LogicalId: string };
      /**
       * Store a value Construction binds. The gateway gets it; the sandbox
       * gets it only with `sandbox` set (the program's own `Config`).
       */
      readonly set: (
        key: string,
        output: Output,
        options?: { readonly sandbox?: boolean },
      ) => Effect.Effect<string>;
    }
  | {
      /** Inside the gateway: bindings are built for real, and their clients kept. */
      readonly phase: "gateway";
      /**
       * The gateway's identity, as at deploy: bindings name what they
       * created after their host, and read it back under that name.
       */
      readonly self: { readonly Type: string; readonly LogicalId: string };
      /** Keep a binding's client for the sandbox to call. */
      readonly register: (key: string, client: unknown) => Effect.Effect<void>;
    }
  | {
      /** Inside the sandbox: bindings are not built; calls go to the gateway. */
      readonly phase: "sandbox";
      /**
       * Bindings that are built in the sandbox after all, by id: the Layer
       * returned is provided around each of their calls. Set by a Layer that
       * lets the sandbox send a request itself with something the gateway
       * hands it (a signature), such as `AWS.SandboxSigner`.
       */
      direct?: (id: string) => Layer.Layer<any> | undefined;
      /** Call `path` on the client the gateway holds under `key`. */
      readonly call: (
        key: string,
        path: ReadonlyArray<string>,
        args: ReadonlyArray<unknown> | undefined,
      ) => Effect.Effect<unknown, unknown>;
    };

/** A secret a binding tried to put in a sandbox that has no gateway. */
export class SecretInSandbox extends Data.TaggedError("SecretInSandbox")<{
  readonly message: string;
}> {}

/**
 * Whether a value bound under `key` may stay on this host. Checked when the
 * value resolves, after every Layer is built, so a gateway installed later
 * still counts.
 */
export const secretInSandbox = (
  ctx: BaseRuntimeContext,
  key: string,
  value: unknown,
): SecretInSandbox | undefined => {
  const host = ctx.root ?? ctx;
  if (
    !Redacted.isRedacted(value) ||
    host.sandbox !== true ||
    ctx.trusted === true ||
    host.gateway !== undefined ||
    host.unprotected === true
  ) {
    return undefined;
  }
  return new SecretInSandbox({
    message:
      `${host.boundBy?.get(key) ?? "A binding"} would put a credential (${key}) in the sandbox ${host.id}, where the code it runs can read it. ` +
      "Provide a gateway Layer to the sandbox's binding Layers (Cloudflare.Workers.SandboxGateway, AWS.Lambda.SandboxGateway, …), " +
      "or Gateway.Unprotected if the sandbox only runs your own code.",
  });
};

/** The host's platform did not issue an OIDC token. */
export class OidcTokenError extends Data.TaggedError("OidcTokenError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Keys a Platform's Init captured through {@link BaseRuntimeContext.set}
 * (`yield* Config.x(...)`, `yield* output`). `Platform.make` attaches the
 * runtime context to the resource and merges these values into its
 * `props.env`.
 */
export const capturedEnvKeys = (resource: unknown): string[] => {
  const ctx = (resource as { RuntimeContext?: Partial<BaseRuntimeContext> })?.RuntimeContext;
  return ctx?.env ? Object.keys(ctx.env) : [];
};

/**
 * Canonicalize a logical key into a key that is safe to use as the name of an
 * environment variable / binding (`[a-zA-Z][a-zA-Z0-9_]*`).
 *
 * `RuntimeContext.set`/`get` are dumb key/value stores: they read and write the
 * key **verbatim**. It is the *caller's* responsibility to hand them a
 * canonical key, since the caller is the one that knows the logical key may
 * contain `.`/`-` (e.g. a dotted config name from `Platform`, or an
 * `Output.toString()` like `"QueueSinkQueue.queueUrl"`). Callers run the key
 * through this before calling `set`/`get` so both sides agree.
 */
export const sanitizeKey = (key: string): string => key.replaceAll(/[^a-zA-Z0-9]/g, "_");

/**
 * The wire format `RuntimeContext.set`/`get` use to carry a `Redacted` value
 * through an environment variable. `JSON.stringify(Redacted)` emits the
 * literal string `"<redacted>"` and loses the value, so secrets are
 * serialized as this marker and the runtime `get` path rebuilds the wrapper.
 */
export interface RedactedMarker {
  readonly _tag: "Redacted";
  readonly value: unknown;
}

/**
 * Detect the (already JSON-parsed) {@link RedactedMarker} shape. After
 * `JSON.parse` the marker is a plain object — `Redacted.isRedacted` is
 * always `false` on it — so detection is structural.
 */
export const isRedactedMarker = (value: unknown): value is RedactedMarker =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Redacted" &&
  "value" in value;

/**
 * Returns true when {@link unpackEnvValue}'s `JSON.parse` would reinterpret
 * the raw string as something other than itself — a number (`"123"`), a
 * boolean, `null`, or a JSON document. Such strings must stay
 * `JSON.stringify`-packed; everything else round-trips verbatim through the
 * parse-failure fallback.
 */
const parsesAsJson = (value: string): boolean => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Serialize a binding value for an env var: `Redacted` values are packed as
 * a {@link RedactedMarker}, non-string values as JSON.
 *
 * A plain string is stored **verbatim** whenever `JSON.parse` would reject
 * it — which is almost every real-world string (names, URLs, ids). Packing
 * those too would put `"my-queue"` (quote characters included) on the wire,
 * where anything that consumes the raw binding without going through
 * {@link unpackEnvValue} — the Cloudflare dashboard, a hand-written env
 * read, a queue-name comparison against `MessageBatch.queue` — sees the
 * quoted form and mismatches (#1243). Only ambiguous strings (`"123"`,
 * `"null"`, JSON documents) keep the pack so the read side can't
 * reinterpret them.
 */
export const packEnvValue = (value: unknown): string =>
  Redacted.isRedacted(value)
    ? JSON.stringify({
        _tag: "Redacted",
        value: Redacted.value(value),
      } satisfies RedactedMarker)
    : typeof value === "string" && !parsesAsJson(value)
      ? value
      : JSON.stringify(value);

/**
 * Like {@link packEnvValue}, but a `Redacted` input keeps its `Redacted`
 * wrapper on the *outside* of the packed string, so deploy-time code can
 * route secrets through a dedicated channel (Cloudflare `secret_text`,
 * Secrets Store) instead of leaking them as plain env vars. The inner
 * payload still carries the marker for the runtime `get` accessor.
 */
export const packEnvValueKeepRedacted = (value: unknown): string | Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value.pipe(packEnvValue, Redacted.make) : packEnvValue(value);

// Only JSON's four whitespace characters may precede a valid JSON value.
const possibleJson = /^[\x20\t\r\n]*["{[0-9tfn-]/;

/**
 * Parse an env-var string produced by {@link packEnvValue} back into its
 * value: rebuild `Redacted` from the marker, return other JSON values
 * as-is, and fall back to the raw string for non-JSON input (a verbatim
 * string from `packEnvValue`, or an env var the user set directly).
 * `undefined` passes through.
 *
 * Runtime `get` accessors MUST feed this from the raw environment
 * (`process.env[key]` / the platform env object) — never through
 * `Config.String`: the ambient runtime `ConfigProvider` reifies bound
 * values (unwrapping the marker before it could be detected here), and
 * during init the ambient provider is the interceptor installed in
 * `Platform.ts`, whose runtime branch calls back into `ctx.get(key)` —
 * resolving through `Config` would re-enter it for the same key and
 * recurse forever.
 */
export const unpackEnvValue = <T>(raw: string | undefined): T | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string" && !possibleJson.test(raw)) {
    return raw as unknown as T;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRedactedMarker(parsed)) {
      return Redacted.make(parsed.value) as unknown as T;
    }
    return parsed as T;
  } catch {
    return raw as unknown as T; // assume it's just a string
  }
};

/**
 * Context of the runtime environment.
 *
 * E.g. the context of a running Worker, Task, Process, Function
 */
export class RuntimeContext extends Context.Service<RuntimeContext, BaseRuntimeContext>()(
  "RuntimeContext",
) {
  static phantom = Layer.empty as Layer.Layer<RuntimeContext>;
}

export const CurrentRuntimeContext = Effect.serviceOption(RuntimeContext).pipe(
  Effect.map(Option.getOrUndefined),
);
