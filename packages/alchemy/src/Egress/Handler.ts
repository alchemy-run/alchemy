/**
 * What an egress does with one request, and where its credential comes
 * from. Shared by every egress kind and both runtimes: the gateway
 * (`Egress.Gateway.serve`) and the Durable Object that owns a Cloudflare
 * container (`Cloudflare.Egress`).
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Output from "../Output.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * What an egress does with one request: return the request to forward
 * (rewritten, e.g. with credentials added), or a response to answer with
 * instead (e.g. a refusal).
 */
export type EgressHandler<R = never> = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<
  HttpClientRequest.HttpClientRequest | HttpServerResponse.HttpServerResponse,
  never,
  R
>;

/** Answer a request with a refusal the program can read. */
export const refuse = (reason: string, status = 403) =>
  HttpServerResponse.text(`alchemy egress: ${reason}\n`, { status });

//#region secrets

/** A secret an egress adds to requests: a value, a `Config`, or an `Output` (e.g. `GitHub.ProfileToken`). */
export type EgressSecret =
  | Redacted.Redacted<string>
  | Config.Config<Redacted.Redacted<string>>
  | Output.Output<Redacted.Redacted<string>, any>;

/**
 * Numbers the secrets a gateway's constructor binds, so two egresses of one
 * kind in one gateway (each with its own token) bind distinct names. The
 * constructor runs in the same order at deploy and at run time, so the
 * numbering matches on both sides.
 */
export class EgressSecretScope extends Context.Service<EgressSecretScope, EgressSecretNames>()(
  "alchemy/Egress/SecretScope",
) {}

export interface EgressSecretNames {
  readonly next: (name: string) => string;
}

export const makeEgressSecretScope = (): EgressSecretNames => {
  const counts = new Map<string, number>();
  return {
    next: (name) => {
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      return n === 0 ? name : `${name}_${n}`;
    },
  };
};

/** `name`, numbered when a gateway's constructor binds it more than once. */
export const uniqueBindingName = (name: string): Effect.Effect<string> =>
  Effect.map(Effect.serviceOption(EgressSecretScope), (scope) =>
    scope._tag === "Some" ? scope.value.next(name) : name,
  );

/**
 * Resolve an {@link EgressSecret} in a construction phase (a Durable Object
 * or a gateway's host) to an effect that reads it at runtime. `Config`s and
 * `Output`s are bound into the hosting Worker or Lambda (as secrets), never
 * into a sandbox.
 */
export const egressSecret = (
  secret: EgressSecret,
  name: string,
): Effect.Effect<Effect.Effect<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    name = yield* uniqueBindingName(name);
    if (Output.isOutput(secret)) {
      // Resolved by the stack while planning (where the Output's services,
      // e.g. GitHub credentials, are provided); read from the host's env at
      // runtime.
      const bound = Output.named(secret, name).asEffect() as unknown as Effect.Effect<
        Effect.Effect<Redacted.Redacted<string>>
      >;
      return yield* bound;
    }
    if (Config.isConfig(secret)) {
      // A missing secret is a misconfigured deployment, not a runtime error.
      const config = secret;
      const value = yield* Effect.gen(function* () {
        return yield* config;
      }).pipe(
        Effect.mapError((cause) => new Error(`egress secret ${name}: ${cause.message}`)),
        Effect.orDie,
      );
      return Effect.succeed(value);
    }
    return Effect.succeed(secret);
  });

//#endregion

//#region credentials

/** Who a request is made for: the subject carried in the signed grant. */
export interface CredentialInput {
  readonly subject: string;
}

/**
 * A credential: static (an {@link EgressSecret}), or a function of the
 * grant's subject, resolved per request and cached per subject briefly.
 */
export type Credential<A> =
  | EgressSecret
  | ((input: CredentialInput) => Effect.Effect<A, unknown, RuntimeContext>);

/** How long a per-subject credential is reused before it is looked up again. */
export const CREDENTIAL_TTL_MILLIS = 60_000;

/**
 * A per-key lookup cached for `ttlMillis` (in this isolate's memory: plain
 * values only). A failed lookup is not cached.
 */
export const cachedLookup = <K, A, E, R>(
  ttlMillis: number,
  lookup: (key: K) => Effect.Effect<A, E, R>,
) => {
  const entries = new Map<K, { readonly value: A; readonly expires: number }>();
  return (key: K): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = entries.get(key);
      if (cached && cached.expires > now) return cached.value;
      const value = yield* lookup(key);
      if (entries.size > 1024) entries.clear();
      entries.set(key, { value, expires: now + ttlMillis });
      return value;
    });
};

//#endregion

//#region bodies

/** The request body as bytes (decompressed when gzipped). Buffers a streamed body. */
export const bodyBytes = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const body = request.body;
    const raw =
      body._tag === "Uint8Array"
        ? body.body
        : body._tag === "Stream"
          ? yield* Stream.mkUint8Array(body.stream).pipe(
              Effect.orElseSucceed(() => new Uint8Array()),
            )
          : new Uint8Array();
    if (request.headers["content-encoding"] !== "gzip") return raw;
    return yield* Effect.promise(async () => {
      const stream = new Response(raw as BufferSource).body!.pipeThrough(
        new DecompressionStream("gzip"),
      );
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  });

/** The request with its body buffered (so it can be read, then forwarded). */
export const bufferBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const body = request.body;
    if (body._tag !== "Stream") return request;
    const raw = yield* Stream.mkUint8Array(body.stream).pipe(
      Effect.orElseSucceed(() => new Uint8Array()),
    );
    return HttpClientRequest.bodyUint8Array(request, raw, body.contentType);
  });

/**
 * Read a streamed body only until `complete(bytesSoFar)` says enough has
 * arrived; return those bytes and the request with its full body, replayed
 * (the rest still streaming). A buffered body is returned as is.
 */
export const peekBody = (
  request: HttpClientRequest.HttpClientRequest,
  complete: (bytes: Uint8Array) => boolean,
) =>
  Effect.gen(function* () {
    const body = request.body;
    if (body._tag !== "Stream") return { head: yield* bodyBytes(request), request };
    const reader = Stream.toReadableStream(body.stream).getReader();
    const chunks: Array<Uint8Array> = [];
    let head = new Uint8Array();
    let done = false;
    while (!done && !complete(head)) {
      const next = yield* Effect.promise(() => reader.read());
      if (next.done) done = true;
      else {
        chunks.push(next.value);
        const joined = new Uint8Array(head.length + next.value.length);
        joined.set(head);
        joined.set(next.value, head.length);
        head = joined;
      }
    }
    const replay = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (done) controller.close();
      },
      pull: async (controller) => {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return {
      head,
      request: HttpClientRequest.bodyStream(
        request,
        Stream.fromReadableStream({ evaluate: () => replay, onError: (cause) => cause }),
        {
          contentType: body.contentType,
          ...(body.contentLength !== undefined ? { contentLength: body.contentLength } : {}),
        },
      ),
    };
  });

//#endregion
