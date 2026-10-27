import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- the recipe: HMAC-signed service requests

/** Which service sent the request, and the nonce it signed. */
class Caller extends Domain.RequestContext<Caller>()(
  "Test/Caller",
  Schema.Struct({ service: Schema.String, nonce: Schema.String }),
) {}

/** The request isn't signed by a service the Api knows. */
class BadSignature extends Schema.TaggedError<BadSignature>()("BadSignature", {}) {}

/** Authenticates a request another service signed. Its client signs every call. */
class ServiceAuth extends RpcMiddleware.Service<ServiceAuth, { provides: Caller }>()(
  "Test/ServiceAuth",
  { error: BadSignature, requiredForClient: true },
) {}

/** How far a signature's timestamp may be from the Api's clock, either way. */
const MAX_AGE_MS = 5 * 60_000;

interface Signed {
  readonly service: string;
  readonly timestamp: string;
  readonly nonce: string;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

/**
 * What a signature covers: the RPC, who sent it, when, a nonce, and the
 * payload as the RPC's own schema encodes it. Middleware sees each request's
 * payload, on both sides, so the signature covers one request, not the HTTP
 * body (one body may carry several requests).
 */
const signedText = (rpc: Rpc.AnyWithProps, payload: unknown, signed: Signed) =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema as Schema.Codec<unknown>))(
    payload,
  ).pipe(
    Effect.map((json) =>
      [rpc._tag, signed.service, signed.timestamp, signed.nonce, JSON.stringify(json)].join("\n"),
    ),
    Effect.orDie,
  );

const sign = (secret: string, text: string) =>
  Effect.promise(async () => {
    const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), bytes(text));
    return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  });

/** `crypto.subtle.verify` compares in constant time. */
const verify = (secret: string, text: string, signature: string) =>
  Effect.promise(async () => {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const mac = new Uint8Array(signature.match(/../g)!.map((pair) => parseInt(pair, 16)));
    return crypto.subtle.verify("HMAC", await hmacKey(secret), mac, bytes(text));
  });

/** Client side: sign every call as `service`. */
const serviceAuthClient = (service: string, secret: string) =>
  RpcMiddleware.layerClient(ServiceAuth, ({ rpc, request, next }) =>
    Effect.gen(function* () {
      const timestamp = String(yield* Clock.currentTimeMillis);
      const nonce = crypto.randomUUID();
      const text = yield* signedText(rpc, request.payload, { service, timestamp, nonce });
      return yield* next({
        ...request,
        headers: Headers.setAll(request.headers, {
          "x-service": service,
          "x-timestamp": timestamp,
          "x-nonce": nonce,
          "x-signature": yield* sign(secret, text),
        }),
      });
    }),
  );

/**
 * Server side: check the signature with the calling service's secret, refuse
 * a timestamp too far from now or a nonce seen before, and provide the
 * {@link Caller}. A nonce is remembered until its signature expires, so a
 * request can't be replayed while it's still valid. One process remembers
 * nonces here; a deployment keeps them in a Durable Object.
 */
const ServiceAuthLive = (secrets: Readonly<Record<string, string>>, maxAgeMs = MAX_AGE_MS) =>
  Layer.effect(
    ServiceAuth,
    Effect.gen(function* () {
      const seen = yield* Ref.make(new Map<string, number>());
      const claim = (nonce: string, until: number, now: number) =>
        Ref.modify(seen, (nonces) => {
          const kept = new Map([...nonces].filter(([, expires]) => expires >= now));
          if (kept.has(nonce)) return [false, kept] as const;
          return [true, kept.set(nonce, until)] as const;
        });
      return (effect, { rpc, payload, headers }) =>
        Effect.gen(function* () {
          const header = (name: string) => Option.getOrUndefined(Headers.get(headers, name));
          const service = header("x-service");
          const timestamp = header("x-timestamp");
          const nonce = header("x-nonce");
          const signature = header("x-signature");
          // Own keys only: `secrets["constructor"]` is a function every attacker knows.
          const secret =
            service !== undefined && Object.hasOwn(secrets, service) ? secrets[service] : undefined;
          if (!service || !secret || !timestamp || !nonce || !signature) {
            return yield* new BadSignature();
          }
          const now = yield* Clock.currentTimeMillis;
          const sentAt = Number(timestamp);
          if (!(Math.abs(now - sentAt) <= maxAgeMs)) return yield* new BadSignature();
          const text = yield* signedText(rpc, payload, { service, timestamp, nonce });
          if (!(yield* verify(secret, text, signature))) return yield* new BadSignature();
          if (!(yield* claim(nonce, sentAt + maxAgeMs, now))) return yield* new BadSignature();
          return yield* Effect.provideService(effect, Caller, { service, nonce });
        });
    }),
  );

// ---------------------------------------------------------------- a ledger other services credit

class Credited extends Domain.Event("Credited", { amount: Schema.Number, by: Schema.String }) {}
class Credit extends Domain.Command("Credit", {
  target: Schema.String,
  middleware: [ServiceAuth],
  input: { amount: Schema.Number },
  events: [Credited],
  reply: { balance: Schema.Number },
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number, by: Schema.Array(Schema.String) }),
  initial: { balance: 0, by: [] },
  commands: [Credit],
  decide: {
    Credit: Effect.fn(function* (_, cmd) {
      return [new Credited({ amount: cmd.amount, by: (yield* Caller).service })];
    }),
  },
  evolve: { Credited: (s, e) => ({ balance: s.balance + e.amount, by: [...s.by, e.by] }) },
  reply: { Credit: (s) => ({ balance: s.balance }) },
  read: { middleware: [ServiceAuth] },
}) {}
class Ledgers extends Domain.Model("Ledgers", { aggregates: [Ledger] }) {}
class LedgerApi extends Domain.Api("LedgerApi", Credit, Ledger) {}

// ---------------------------------------------------------------- the Api over HTTP, in process

const SECRETS = { billing: "billing-secret" };

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Serve the Api's `fetch` as a web handler, and point `fetch` at it, so calls
 * go over the real HTTP protocol (NDJSON). Every request sent is recorded,
 * for the replay tests; `tamper` changes a body in transit, and `maxAgeMs`
 * shortens how long a signature stays valid.
 */
const withServer = <A, E, R>(
  test: (
    send: (request: Sent) => Effect.Effect<string>,
    sent: Array<Sent>,
  ) => Effect.Effect<A, E, R>,
  {
    tamper = (body) => body,
    maxAgeMs,
  }: { readonly tamper?: (body: string) => string; readonly maxAgeMs?: number } = {},
) =>
  Effect.gen(function* () {
    const handler = HttpEffect.toWebHandler((yield* LedgerApi).fetch);
    const sent: Array<Sent> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const recorded: Sent = {
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: tamper(await request.text()),
      };
      sent.push(recorded);
      return handler(new Request(recorded.url, { method: "POST", ...recorded }));
    };
    const send = (request: Sent) =>
      Effect.promise(() =>
        handler(new Request(request.url, { method: "POST", ...request })).then((r) => r.text()),
      );
    return yield* test(send, sent).pipe(
      Effect.provide(Domain.protocolHttp("http://ledger.test/")),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
    );
  }).pipe(
    Effect.provide(
      Ledgers.layer(Layer.empty).pipe(
        Layer.provideMerge(Layer.mergeAll(InMemory, ServiceAuthLive(SECRETS, maxAgeMs))),
      ),
    ),
  );

const creditCalls = (sent: ReadonlyArray<Sent>) => sent.filter((s) => s.body.includes('"Credit"'));
const creditCall = (sent: ReadonlyArray<Sent>) => creditCalls(sent)[0]!;

/** Run `effect` with a clock `ms` ahead of the real one, like a caller whose clock runs fast. */
const ahead =
  (ms: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Clock.clockWith((clock) =>
      Effect.provideService(
        effect,
        Clock.Clock,
        Object.assign(Object.create(clock) as Clock.Clock, {
          currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now + ms),
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
        }),
      ),
    );

describe("Domain signed service requests", () => {
  it.live("a signed call reaches decide as the calling service", () =>
    withServer(() =>
      Effect.gen(function* () {
        const ledger = yield* LedgerApi.client;
        const { reply } = yield* ledger.Credit({ target: "acct-1", amount: 5 });
        expect(reply).toEqual({ balance: 5 });
        expect(yield* ledger.Ledger.get("acct-1")).toEqual({ balance: 5, by: ["billing"] });
      }).pipe(Effect.scoped, Effect.provide(serviceAuthClient("billing", SECRETS.billing))),
    ),
  );

  it.live("a call signed with another secret is refused", () =>
    withServer(() =>
      Effect.gen(function* () {
        const ledger = yield* LedgerApi.client;
        const refused = yield* ledger.Credit({ target: "acct-1", amount: 5 }).pipe(Effect.flip);
        expect(refused._tag).toBe("BadSignature");
      }).pipe(Effect.scoped, Effect.provide(serviceAuthClient("billing", "a-guess"))),
    ),
  );

  it.live("a replayed request is refused", () =>
    withServer((send, sent) =>
      Effect.gen(function* () {
        const ledger = yield* LedgerApi.client;
        yield* ledger.Credit({ target: "acct-1", amount: 5 });
        expect(yield* send(creditCall(sent))).toContain('"BadSignature"');
        expect(yield* ledger.Ledger.get("acct-1")).toMatchObject({ balance: 5 });
      }).pipe(Effect.scoped, Effect.provide(serviceAuthClient("billing", SECRETS.billing))),
    ),
  );

  it.live("a payload changed in transit no longer matches its signature", () =>
    withServer(
      () =>
        Effect.gen(function* () {
          const ledger = yield* LedgerApi.client;
          const refused = yield* ledger.Credit({ target: "acct-1", amount: 5 }).pipe(Effect.flip);
          expect(refused._tag).toBe("BadSignature");
        }).pipe(Effect.scoped, Effect.provide(serviceAuthClient("billing", SECRETS.billing))),
      { tamper: (body) => body.replace('"amount":5', '"amount":500') },
    ),
  );

  it.live("a service name off the secrets' prototype is refused", () =>
    withServer(() =>
      Effect.gen(function* () {
        const ledger = yield* LedgerApi.client;
        const refused = yield* ledger.Credit({ target: "acct-1", amount: 5 }).pipe(Effect.flip);
        expect(refused._tag).toBe("BadSignature");
      }).pipe(
        Effect.scoped,
        // `secrets["constructor"]` is `Object`, whose text anyone can sign with.
        Effect.provide(serviceAuthClient("constructor", String(Object))),
      ),
    ),
  );

  it.live("a request from a fast clock can't be replayed while it's still valid", () =>
    withServer(
      (send, sent) =>
        Effect.gen(function* () {
          const ledger = yield* LedgerApi.client;
          // Signed 900ms in the future: valid until 1900ms from now.
          yield* ledger.Credit({ target: "acct-1", amount: 5 }).pipe(ahead(900));
          yield* Effect.sleep("1100 millis");
          // Another call, so the Api forgets the nonces it no longer needs.
          yield* ledger.Credit({ target: "acct-1", amount: 5 });
          expect(yield* send(creditCall(sent))).toContain('"BadSignature"');
          expect(yield* ledger.Ledger.get("acct-1")).toMatchObject({ balance: 10 });
        }).pipe(Effect.scoped, Effect.provide(serviceAuthClient("billing", SECRETS.billing))),
      { maxAgeMs: 1000 },
    ),
  );
});
