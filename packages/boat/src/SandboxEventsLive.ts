import * as boat from "@distilled.cloud/boat-dev/boat";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isRedactedMarker, RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { bindBoat, bindOwnerLabels, type BoatAuth } from "./BoatBindings.ts";
import { ALCHEMY_LABEL_PREFIX } from "./internal/Ownership.ts";
import {
  type SandboxEvent,
  SandboxEvents,
  type SandboxEventsProps,
  type SandboxEventsService,
  sandboxEventsPath,
  sandboxEventsSecretEnvName,
} from "./SandboxEvents.ts";
import { ALL_SANDBOX_EVENTS, Webhook } from "./Webhook.ts";

/** How old a delivery's timestamp may be before it is refused. */
const MAX_AGE_SECONDS = 300;

/**
 * {@link SandboxEvents} on any {@link WebhookHost}: every Cloudflare Worker
 * is one.
 *
 * @layer
 * @product Webhook
 * @provides Boat.SandboxEvents
 */
export const SandboxEventsLive = Layer.effect(
  SandboxEvents,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    // Yielding the resource class erases its `Providers` requirement; the
    // stack satisfies it at plan time.
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      props: SandboxEventsProps,
      process: (event: SandboxEvent) => Effect.Effect<void, never, any>,
    ) {
      const path = sandboxEventsPath(props);

      // Boat generates the signing secret. It goes to the host as a binding,
      // not a prop: the webhook depends on the host's URL.
      const runtime = yield* RuntimeContext;
      const secretKey = sandboxEventsSecretEnvName(path);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Boat delivers only to public HTTPS URLs, and under `alchemy dev`
            // the host is on localhost: skip the webhook rather than fail.
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Boat.consumeSandboxEvents: no webhook for ${path} under alchemy dev; Boat only delivers to public URLs, so deploy to receive events.`,
              );
              return;
            }
            const hook = yield* createWebhook(`BoatEvents${path}`, {
              url: Output.interpolate`${host.url}${path}`,
              events: [...(props.events ?? ALL_SANDBOX_EVENTS)],
            });
            yield* host.bind(`boat-webhook:${path}`, { env: { [secretKey]: hook.secret } });
          }),
        );
      }
      const boundSecret = Effect.map(runtime.get<unknown>(secretKey), asSecret);

      // Scoped to the stack: the host reads each sandbox's labels with a
      // key that may only read sandboxes.
      const scope =
        (props.scope ?? "stack") === "stack"
          ? {
              auth: yield* bindBoat("BoatEventsKey", "BOAT_EVENTS_KEY", {
                actions: ["sandbox.read"],
              }),
              owner: yield* bindOwnerLabels,
            }
          : undefined;

      yield* host.route(path, (request) => handleDelivery(request, boundSecret, scope, process));
    }) as SandboxEventsService;
  }),
);

interface Scope {
  readonly auth: BoatAuth;
  readonly owner: Effect.Effect<Readonly<Record<string, string>>>;
}

const handleDelivery = <Req>(
  request: Request,
  secret: Effect.Effect<string | undefined>,
  scope: Scope | undefined,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req | RuntimeContext> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = yield* Effect.tryPromise(() => request.text()).pipe(Effect.option);
    if (body._tag === "None") return new Response("unreadable body", { status: 400 });

    const delivery = request.headers.get("x-ascii-delivery") ?? "";
    const timestamp = request.headers.get("x-ascii-timestamp") ?? "";
    const signature = (request.headers.get("x-ascii-signature") ?? "").replace(/^v1=/, "");
    const now = yield* Clock.currentTimeMillis;
    const issuedAt = Number(timestamp);
    const fresh =
      Number.isFinite(issuedAt) && Math.abs(Number(now) / 1000 - issuedAt) <= MAX_AGE_SECONDS;
    const valid =
      fresh &&
      (yield* verifySignature(
        (yield* secret) ?? "",
        `${delivery}.${timestamp}.${body.value}`,
        signature,
      ));
    if (!valid) return new Response("invalid signature", { status: 401 });

    const parsed = yield* Effect.try(
      () => JSON.parse(body.value) as Omit<SandboxEvent, "attempt">,
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (parsed === undefined || typeof parsed.data?.sandbox?.id !== "string") {
      return new Response("invalid payload", { status: 400 });
    }
    let event: SandboxEvent = {
      ...parsed,
      attempt: Number(request.headers.get("x-ascii-attempt") ?? "1") || 1,
    };

    if (scope !== undefined) {
      const labels = yield* labelsOf(scope.auth, parsed.data.sandbox.id);
      const owner = yield* scope.owner;
      const ours =
        labels !== undefined &&
        ["stack", "stage"].every(
          (key) =>
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
const asSecret = (raw: unknown): string | undefined => {
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

/** A sandbox's labels, or `undefined` when it is gone or can't be read. */
const labelsOf = (auth: BoatAuth, sandboxId: string) =>
  auth.authorize(boat.getSandbox({ sandboxId })).pipe(
    Effect.map((got) =>
      Object.fromEntries(
        Object.entries(got.sandbox?.labels ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    ),
    Effect.orElseSucceed(() => undefined),
  );

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Boat's signature: hex HMAC-SHA256 of `<delivery>.<timestamp>.<body>`,
 * computed with Web Crypto so it runs on Workers without `nodejs_compat`.
 */
const verifySignature = (
  secret: string,
  signed: string,
  signature: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (secret === "" || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const mac = yield* Effect.tryPromise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    ).pipe(
      Effect.flatMap((key) =>
        Effect.tryPromise(() => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed))),
      ),
      Effect.option,
    );
    if (mac._tag === "None") return false;
    return timingSafeEqual(toHex(mac.value), signature.toLowerCase());
  });

/** Constant-time comparison; `crypto.timingSafeEqual` needs `nodejs_compat` on Workers. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};
