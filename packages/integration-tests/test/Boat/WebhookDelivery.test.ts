import { handleDelivery, MAX_BODY_BYTES } from "@alchemy.run/boat/internal/WebhookDelivery";
import { expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const tags = ["unit", "provider:boat", "local"];

const SECRET = "whsec_test_secret";
const TYPES = new Set(["sandbox.ready", "sandbox.archived"]);

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Signs a delivery the way Boat documents: HMAC-SHA256 of `<delivery>.<timestamp>.<body>`. */
const sign = (secret: string, delivery: string, timestamp: string, body: string) =>
  Effect.promise(() =>
    crypto.subtle
      .importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      .then((key) =>
        crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${delivery}.${timestamp}.${body}`),
        ),
      ),
  ).pipe(Effect.map(hex));

const event = (id: string, type = "sandbox.ready") =>
  JSON.stringify({
    id,
    type,
    createdAt: "2026-11-07T12:00:00.000Z",
    data: { sandbox: { id: "bx_test", name: "test" }, previousState: "cloning", state: "ready" },
  });

/** A delivery as Boat sends it, signed with `secret`, `ageSeconds` old. */
const delivery = Effect.fn(function* (options: {
  readonly id?: string;
  readonly body?: string;
  readonly secret?: string;
  readonly ageSeconds?: number;
  readonly headerId?: string;
}) {
  const id = options.id ?? "evt_1";
  const body = options.body ?? event(id);
  const now = Math.floor(Number(yield* Clock.currentTimeMillis) / 1000);
  const timestamp = String(now - (options.ageSeconds ?? 0));
  const headerId = options.headerId ?? id;
  const signature = yield* sign(options.secret ?? SECRET, headerId, timestamp, body);
  return new Request("https://worker.example/__alchemy/boat/events", {
    method: "POST",
    body,
    headers: {
      "x-ascii-delivery": headerId,
      "x-ascii-timestamp": timestamp,
      "x-ascii-signature": `v1=${signature}`,
      "x-ascii-attempt": "1",
    },
  });
});

/** Runs a request through the handler; returns the status and the events the handler saw. */
const deliver = Effect.fn(function* (request: Request, options?: { readonly secret?: string }) {
  const secret = options === undefined ? SECRET : options.secret;
  const seen: string[] = [];
  const response = yield* handleDelivery(
    request,
    Effect.succeed(secret),
    TYPES,
    undefined,
    (received) => Effect.sync(() => void seen.push(received.id)),
  ) as Effect.Effect<Response>;
  return { status: response.status, seen };
});

it.live(
  "a correctly signed, fresh delivery reaches the handler",
  () =>
    Effect.gen(function* () {
      expect(yield* deliver(yield* delivery({}))).toEqual({ status: 202, seen: ["evt_1"] });
    }),
  { tags },
);

it.live(
  "a delivery signed with another secret is refused",
  () =>
    Effect.gen(function* () {
      expect(yield* deliver(yield* delivery({ secret: "whsec_other" }))).toEqual({
        status: 401,
        seen: [],
      });
    }),
  { tags },
);

it.live(
  "a delivery older than five minutes is refused, even when correctly signed",
  () =>
    Effect.gen(function* () {
      expect(yield* deliver(yield* delivery({ ageSeconds: 301 }))).toEqual({
        status: 401,
        seen: [],
      });
      expect(yield* deliver(yield* delivery({ ageSeconds: 240 }))).toEqual({
        status: 202,
        seen: ["evt_1"],
      });
    }),
  { tags },
);

it.live(
  "a tampered body is refused",
  () =>
    Effect.gen(function* () {
      const signed = yield* delivery({});
      const tampered = new Request(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: event("evt_1", "sandbox.archived"),
      });
      expect(yield* deliver(tampered)).toEqual({ status: 401, seen: [] });
    }),
  { tags },
);

it.live(
  "a body whose event id isn't the signed delivery id is refused",
  () =>
    Effect.gen(function* () {
      expect(
        yield* deliver(yield* delivery({ headerId: "evt_signed", body: event("evt_other") })),
      ).toEqual({ status: 400, seen: [] });
    }),
  { tags },
);

it.live(
  "unsigned, wrongly prefixed, non-POST and oversized requests never reach the handler",
  () =>
    Effect.gen(function* () {
      const url = "https://worker.example/__alchemy/boat/events";
      expect(yield* deliver(new Request(url, { method: "POST", body: event("evt_1") }))).toEqual({
        status: 401,
        seen: [],
      });
      expect(yield* deliver(new Request(url, { method: "GET" }))).toEqual({
        status: 405,
        seen: [],
      });
      const big = new Request(url, {
        method: "POST",
        body: "x".repeat(MAX_BODY_BYTES + 1),
        headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      });
      expect((yield* deliver(big)).status).toBe(413);
    }),
  { tags },
);

it.live(
  "without a bound secret every delivery is refused",
  () =>
    Effect.gen(function* () {
      expect(yield* deliver(yield* delivery({}), { secret: undefined })).toEqual({
        status: 401,
        seen: [],
      });
    }),
  { tags },
);

it.live(
  "an event type the host didn't subscribe to is acknowledged but not handled",
  () =>
    Effect.gen(function* () {
      const body = event("evt_2", "sandbox.degraded");
      expect(yield* deliver(yield* delivery({ id: "evt_2", body }))).toEqual({
        status: 202,
        seen: [],
      });
    }),
  { tags },
);
