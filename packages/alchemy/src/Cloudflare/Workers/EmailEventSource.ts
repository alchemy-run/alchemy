import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as RemovalPolicy from "../../RemovalPolicy.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { Routing } from "../Email/Routing.ts";
import { Rule, type Matcher } from "../Email/Rule.ts";
import type { Reference } from "../Zone/lookup.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

/**
 * Effect-native wrapper around Cloudflare's
 * [`ForwardableEmailMessage`](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/#forwardableemailmessage).
 *
 * Follows the same shape as the other Cloudflare bindings (R2, KV, …):
 *
 * - `raw` is the underlying `cf.ForwardableEmailMessage` — an escape
 *   hatch for any field or future API not yet wrapped.
 * - Ergonomic fields (`from`, `to`, `headers`, `body`, `bodySize`) are
 *   forwarded verbatim.
 * - Action methods (`forward`, `reply`, `setReject`) return `Effect`s
 *   instead of `Promise`/`void`.
 */
export interface ForwardableEmailMessage {
  /** Underlying Cloudflare message — escape hatch for unwrapped APIs. */
  readonly raw: cf.ForwardableEmailMessage;
  /** Envelope From address. */
  readonly from: string;
  /** Envelope To address. */
  readonly to: string;
  /** RFC 5322 headers. */
  readonly headers: cf.Headers;
  /** Raw message body stream (RFC 5322 wire bytes). */
  readonly body: cf.ReadableStream<Uint8Array>;
  /** Size of the raw message body in bytes. */
  readonly bodySize: number;
  /**
   * Reject this message back to the connecting client with a permanent
   * SMTP error and the given reason.
   */
  setReject(reason: string): Effect.Effect<void>;
  /**
   * Forward this message to a verified destination address on the
   * account. Fails with `EmailError` if Cloudflare rejects the forward
   * (e.g. unverified destination).
   */
  forward(
    rcptTo: string,
    headers?: cf.Headers,
  ): Effect.Effect<void, EmailError>;
  /**
   * Reply to the sender with a new outbound message. Fails with
   * `EmailError` if Cloudflare rejects the reply.
   */
  reply(message: cf.EmailMessage): Effect.Effect<void, EmailError>;
}

export class EmailError extends Data.TaggedError("EmailError")<{
  action: "forward" | "reply";
  message: string;
  cause: unknown;
}> {}

const wrap = (raw: cf.ForwardableEmailMessage): ForwardableEmailMessage => ({
  raw,
  from: raw.from,
  to: raw.to,
  headers: raw.headers,
  body: raw.raw,
  bodySize: raw.rawSize,
  // In production `setReject` is synchronous; under the local runtime the
  // message crosses a JSRPC boundary and the call returns a promise the
  // reject flag only lands after — await either form.
  setReject: (reason) =>
    Effect.promise(async () => {
      await (raw.setReject(reason) as void | Promise<void>);
    }),
  forward: (rcptTo, headers) =>
    Effect.tryPromise({
      try: () => raw.forward(rcptTo, headers),
      catch: (cause) =>
        new EmailError({
          action: "forward",
          message: `Cloudflare email forward failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
  reply: (msg) =>
    Effect.tryPromise({
      try: () => raw.reply(msg),
      catch: (cause) =>
        new EmailError({
          action: "reply",
          message: `Cloudflare email reply failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
});

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Settings for {@link email} — both halves of the consumer in one
 * place. `zone` opts in to the deploy-time setup: an `Email.Routing`
 * toggle on the zone plus an `Email.Rule` whose action routes matched
 * mail to the host Worker. Omit `zone` to manage routing yourself.
 */
export interface EmailSubscribeProps {
  /**
   * Zone to enable email routing on and attach the routing rule to.
   * Accepts a zone id, a zone name (`example.com`), or a
   * `{ zoneId, name? }` object (a `Cloudflare.Zone` resource works).
   * Required to auto-create routing resources; omit if you're managing
   * `Email.Routing` and `Email.Rule` yourself.
   */
  zone?: Input<Reference>;
  /**
   * Matchers for the auto-created `Email.Rule`. Ignored when `zone` is
   * omitted.
   *
   * @default [{ type: "all" }]
   */
  matchers?: Matcher[];
  /**
   * Display name for the auto-created `Email.Rule`.
   *
   * @default the host worker's logical id
   */
  ruleName?: string;
  /**
   * Priority of the auto-created `Email.Rule`. Lower numbers run first.
   *
   * @default 0
   */
  priority?: number;
  /**
   * Whether the auto-created `Email.Rule` is enabled.
   *
   * @default true
   */
  enabled?: boolean;
}

/**
 * Subscribe to Cloudflare Email Worker events with an Effect handler.
 *
 * Wires both halves of the consumer in one call:
 *
 * - **Runtime**: registers an `email` event listener on the Worker.
 *   The handler receives a {@link ForwardableEmailMessage} whose
 *   action methods (`forward`, `reply`, `setReject`) return `Effect`s.
 * - **Deploy-time** (when `zone` is set): yields a
 *   `Cloudflare.Email.Routing` toggle on the zone plus a
 *   `Cloudflare.Email.Rule` whose `actions: [{ type: "worker", … }]`
 *   targets this Worker. No manual wiring needed in `alchemy.run.ts`.
 *
 * Requires `EmailEventSourceLive` provided on the Worker's Effect.
 *
 * **Failure & retry semantics**: a failing handler won't crash the
 * Worker — the event source catches the failure and moves on. Express
 * retry declaratively with `Effect.retry` inside the handler, and log
 * or report errors if you need visibility into failed deliveries.
 *
 * ### Subscribing to Inbound Mail
 * **Example:** Catch-all on a zone — auto-creates routing + rule
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * export default Cloudflare.Worker(
 *   "Inbox",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.email({ zone: "example.com" }).subscribe(
 *       (message) => message.forward("ops@example.com"),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
 * );
 * ```
 *
 * **Example:** Match a specific address
 * ```typescript
 * yield* Cloudflare.email({
 *   zone: "example.com",
 *   matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
 * }).subscribe((message) => message.forward("ops@example.com"));
 * ```
 *
 * ### Handling Messages
 * **Example:** Reject (bounce) a message
 * ```typescript
 * yield* Cloudflare.email({ zone: "example.com" }).subscribe((message) =>
 *   message.setReject("Mailbox closed"),
 * );
 * ```
 *
 * **Example:** Bring-your-own routing — no `zone`, no auto-create
 * ```typescript
 * // Manage `Email.Routing` / `Email.Rule` yourself in alchemy.run.ts.
 * yield* Cloudflare.email().subscribe((message) =>
 *   Effect.log(`from ${message.from}`),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/email-routing/email-workers/
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 */
export const email = (props: EmailSubscribeProps = {}) => ({
  subscribe: <E = never, Req = never>(
    process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
  ) => EmailEventSource.use((source) => source(props, process)),
});

export type EmailEventSourceService = <E = never, Req = never>(
  props: EmailSubscribeProps,
  process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
) => Effect.Effect<void, never, never>;

export class EmailEventSource extends Context.Service<
  EmailEventSource,
  EmailEventSourceService
>()("Cloudflare.Workers.EmailEventSource") {}

export const EmailEventSourceLive = Layer.effect(
  EmailEventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <E, Req>(
      props: EmailSubscribeProps,
      process: (
        message: ForwardableEmailMessage,
      ) => Effect.Effect<void, E, Req>,
    ) {
      // Deploy-time: provision the Email.Routing toggle and an Email.Rule
      // routing matched mail to this Worker. Skipped once running inside
      // the deployed Worker (the global guard) and when `zone` is omitted
      // (bring-your-own routing). Namespaced under the host so logical
      // identity is stable per Worker.
      if (!globalThis.__ALCHEMY_RUNTIME__ && props.zone !== undefined) {
        const zone = props.zone;
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // Routing is a per-zone singleton shared with other rules on
            // the zone, so destroying this Worker must not disable it.
            yield* Routing("EmailRouting", {
              zone,
              enabled: true,
            }).pipe(RemovalPolicy.retain());

            yield* Rule("EmailRule", {
              zone,
              name: props.ruleName ?? host.LogicalId,
              enabled: props.enabled ?? true,
              priority: props.priority ?? 0,
              matchers: props.matchers ?? [{ type: "all" }],
              actions: [{ type: "worker", value: [host.workerName] }],
            });
          }),
        );
      }

      // Resolve the runtime context per-call rather than at layer
      // construction (mirrors `Queues.EventSourceLive`).
      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "email") return;

        const message = wrap(event.input as cf.ForwardableEmailMessage);
        return process(message).pipe(
          Effect.onError((cause) =>
            Effect.sync(() => {
              // Surface the failure so the operator sees why a message
              // was dropped; without this the handler fails silently.
              console.error(
                `[EmailEventSource] handler failed for message to ` +
                  `"${message.to}": ${Cause.pretty(cause)}`,
              );
            }),
          ),
          Effect.catchCause(() => Effect.void),
        );
      });
    }) as EmailEventSourceService;
  }),
);
