/**
 * INTERNAL — handles one delivery of Boat's webhook on a host: checks the
 * signature, the timestamp and the payload, then scopes and dispatches it.
 */
import * as boat from "@distilled.cloud/boat-dev/boat";
import { isRedactedMarker, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { BoatAuth } from "../BoatBindings.ts";
import type { SandboxEvent } from "../SandboxEvents.ts";
import { ALCHEMY_LABEL_PREFIX } from "./Ownership.ts";

/** How old a delivery's timestamp may be before it is refused. */
export const MAX_AGE_SECONDS = 300;

/** The largest delivery accepted. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface Scope {
  readonly auth: BoatAuth;
  readonly owner: Effect.Effect<Readonly<Record<string, string>>>;
}

export const handleDelivery = <Req>(
  request: Request,
  secret: Effect.Effect<string | undefined>,
  types: ReadonlySet<string>,
  scope: Scope | undefined,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req | RuntimeContext> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    // Boat's events are a few hundred bytes; refuse anything large before reading it.
    if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
      return new Response("payload too large", { status: 413 });
    }
    const body = yield* Effect.tryPromise(() => request.arrayBuffer()).pipe(Effect.option);
    if (body._tag === "None") return new Response("unreadable body", { status: 400 });
    if (body.value.byteLength > MAX_BODY_BYTES) {
      return new Response("payload too large", { status: 413 });
    }

    // The signature covers the delivery id, the timestamp and the raw body
    // bytes; a stale timestamp is refused, so a captured delivery can't be
    // replayed later.
    const delivery = request.headers.get("x-ascii-delivery") ?? "";
    const timestamp = request.headers.get("x-ascii-timestamp") ?? "";
    const signature = (request.headers.get("x-ascii-signature") ?? "").replace(/^v1=/, "");
    const now = yield* Clock.currentTimeMillis;
    const fresh =
      /^\d{1,12}$/.test(timestamp) &&
      Math.abs(Number(now) / 1000 - Number(timestamp)) <= MAX_AGE_SECONDS;
    const valid =
      delivery !== "" &&
      fresh &&
      (yield* verifySignature(
        (yield* secret) ?? "",
        `${delivery}.${timestamp}.`,
        body.value,
        signature,
      ));
    if (!valid) return new Response("invalid signature", { status: 401 });

    const parsed = yield* Effect.try(
      () => JSON.parse(new TextDecoder().decode(body.value)) as Omit<SandboxEvent, "attempt">,
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (
      parsed === undefined ||
      parsed.id !== delivery ||
      typeof parsed.type !== "string" ||
      typeof parsed.data?.sandbox?.id !== "string"
    ) {
      return new Response("invalid payload", { status: 400 });
    }
    // An event this host didn't subscribe to: acknowledged, not handled.
    if (!types.has(parsed.type)) return new Response(null, { status: 202 });
    let event: SandboxEvent = {
      ...parsed,
      attempt: Number(request.headers.get("x-ascii-attempt") ?? "1") || 1,
    };

    if (scope !== undefined) {
      const lookup = yield* labelsOf(scope.auth, parsed.data.sandbox.id);
      // Boat couldn't be asked: answer 503 so it delivers again, rather than
      // drop an event that may be ours.
      if (lookup._tag === "Unavailable") return new Response("try again", { status: 503 });
      const labels = lookup._tag === "Found" ? lookup.labels : undefined;
      const owner = yield* scope.owner;
      const ours =
        labels !== undefined &&
        ["stack", "stage"].every(
          (key) =>
            owner[`${ALCHEMY_LABEL_PREFIX}${key}`] !== undefined &&
            labels[`${ALCHEMY_LABEL_PREFIX}${key}`] === owner[`${ALCHEMY_LABEL_PREFIX}${key}`],
        );
      // Another stack's sandbox, or one already deleted: acknowledged, not handled.
      if (!ours) return new Response(null, { status: 202 });
      event = { ...event, data: { ...event.data, sandbox: { ...event.data.sandbox, labels } } };
    }

    yield* process(event);
    return new Response(null, { status: 202 });
  });

/** The bound secret as a string: a `Redacted`, its serialized form, or a plain string. */
export const asSecret = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Redacted.isRedacted(raw)) {
    const value = Redacted.value(raw);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (isRedactedMarker(raw) && typeof raw.value === "string") {
    return raw.value.length > 0 ? raw.value : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
};

type LabelLookup =
  | { readonly _tag: "Found"; readonly labels: Record<string, string> }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Unavailable" };

/** A sandbox's labels; `Gone` when Boat no longer has it, `Unavailable` when Boat couldn't be asked. */
const labelsOf = (
  auth: BoatAuth,
  sandboxId: string,
): Effect.Effect<LabelLookup, never, RuntimeContext> =>
  auth.authorize(boat.getSandbox({ sandboxId })).pipe(
    Effect.map((got): LabelLookup => ({
      _tag: "Found",
      labels: Object.fromEntries(
        Object.entries(got.sandbox?.labels ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    })),
    Effect.catchTag("NotFound", () => Effect.succeed<LabelLookup>({ _tag: "Gone" })),
    Effect.orElseSucceed((): LabelLookup => ({ _tag: "Unavailable" })),
  );

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/**
 * Boat's signature: hex HMAC-SHA256 of `<delivery>.<timestamp>.` followed
 * by the raw body bytes. Web Crypto checks it (in constant time), so it runs
 * on Workers without `nodejs_compat`.
 */
const verifySignature = (
  secret: string,
  prefix: string,
  body: ArrayBuffer,
  signature: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (secret === "" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const head = new TextEncoder().encode(prefix);
    const signed = new Uint8Array(head.byteLength + body.byteLength);
    signed.set(head, 0);
    signed.set(new Uint8Array(body), head.byteLength);
    const valid = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    ).pipe(
      Effect.flatMap((key) =>
        Effect.tryPromise(() =>
          crypto.subtle.verify("HMAC", key, fromHex(signature.toLowerCase()), signed),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
    return valid;
  });
