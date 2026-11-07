import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { rpcMethodOf } from "alchemy/Rpc";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

/*
 * Who may call a program's RPC methods. Every binding that calls them
 * (`Modal.InvokeFunction`, `Modal.FetchServer`) gets its own random key: the
 * caller keeps the key, the target keeps only its SHA-256, and each RPC call
 * carries the key. A key opens one target for one caller, so a target can't
 * replay what it receives to another target. Modal's own access control
 * (proxy auth, environment roles) still applies underneath.
 */

/** Env var on the target: the SHA-256 (hex) of each caller's key, as a JSON array. */
export const RPC_CALLERS_ENV = "ALCHEMY_MODAL_RPC_CALLERS";

/** Request header a Server's RPC call carries its key in. */
export const RPC_KEY_HEADER = "x-alchemy-rpc-key";

/** Keyword argument a Function's RPC call carries its key in (the entrypoint forwards it as {@link RPC_KEY_HEADER}). */
export const RPC_KEY_KWARG = "__alchemy_rpc_key__";

/** Env var on the caller holding its key for the target `targetId`. */
export const rpcKeyEnv = (targetId: string) => sanitizeKey(`ALCHEMY_MODAL_RPC_KEY_${targetId}`);

/** What a caller's binding attaches to the target. */
export interface RpcCallerBinding {
  /** SHA-256 (hex) of the caller's key. */
  readonly rpcCallers?: ReadonlyArray<string>;
}

/** SHA-256 of `text`, as hex. */
export const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/** The caller key hashes a target's bindings recorded, sorted. */
export const rpcCallersOf = (
  bindings: ReadonlyArray<{ readonly data: RpcCallerBinding }>,
): string[] => [...new Set(bindings.flatMap((binding) => binding.data.rpcCallers ?? []))].sort();

type BindTarget = {
  readonly LogicalId: string;
  bind: (...args: unknown[]) => (data: RpcCallerBinding) => Effect.Effect<void>;
};

/**
 * The caller half of an RPC binding. Yield it while the binding's layer is
 * built; call the result with the target in the binding. At deploy it mints
 * the key for this caller and target (`<host><target>RpcKey`), binds it into
 * the host's env, and records its hash on the target. At run time it reads
 * the key back, or `undefined` when the caller has none (a script).
 */
export const RpcCaller = Effect.gen(function* () {
  // Deploy only: a host bundle never creates the key.
  const Key = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* Random;
  return Effect.fn(function* (target: { readonly LogicalId: string }) {
    // The host binding the target, read per call: one binding layer serves
    // every host in the Stack, so a host captured when the layer was built
    // would be the first one to build it.
    const runtime = yield* CurrentRuntimeContext;
    const env = rpcKeyEnv(target.LogicalId);
    if (!globalThis.__ALCHEMY_RUNTIME__ && Key !== undefined && runtime !== undefined) {
      const host = yield* Binding.Host;
      if (host !== undefined) {
        const key = yield* Key(`${host.LogicalId}${target.LogicalId}RpcKey`, {});
        yield* runtime.set(env, key.text);
        yield* (target as unknown as BindTarget).bind`Modal.RpcCaller(${host})`({
          rpcCallers: [
            key.text.pipe(
              Output.mapEffect((text) => text.pipe(Redacted.value, sha256Hex)),
            ) as unknown as string,
          ],
        });
      }
    }
    return Effect.gen(function* () {
      if (runtime === undefined) return undefined;
      const value = yield* runtime.get<string | Redacted.Redacted<string>>(env);
      return value === undefined
        ? undefined
        : Redacted.isRedacted(value)
          ? Redacted.value(value)
          : value;
    });
  });
});

/**
 * Serve `rpc` only to callers whose key's hash is in {@link RPC_CALLERS_ENV};
 * every other request goes to `fallback`. A call without a key, or with one
 * no binding issued, gets `401`.
 */
export const requireRpcCaller = <A, E, R, A2, E2, R2>(
  callers: ReadonlySet<string>,
  rpc: Effect.Effect<A, E, R>,
  fallback: Effect.Effect<A2, E2, R2>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    if (rpcMethodOf(request) === undefined) return yield* fallback;
    const key = request.headers[RPC_KEY_HEADER];
    if (typeof key !== "string" || key.length === 0 || !callers.has(yield* sha256Hex(key))) {
      return HttpServerResponse.text("Unauthorized: this caller has no binding to the program", {
        status: 401,
      });
    }
    return yield* rpc;
  });

/** The caller key hashes in a target's env (see {@link RPC_CALLERS_ENV}). */
export const parseCallers = (value: unknown): ReadonlySet<string> => {
  const list = typeof value === "string" ? safeParse(value) : value;
  return new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);
};

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
