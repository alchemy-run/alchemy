import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";

/**
 * Configuration for a `send_email` binding on a Worker.
 *
 * `name` becomes the env key (e.g. `env.EMAIL`) and uniquely identifies
 * the binding within the Worker. Use either `destinationAddress` or
 * `allowedDestinationAddresses` to restrict where the Worker can send.
 * Omit both to allow sending to any verified destination address on the
 * account. Destination and sender addresses must be verified in the
 * Cloudflare Email Routing dashboard before they can be used.
 */
export interface SendEmailConfig {
  /**
   * Binding name. This is the key used to access the binding from the
   * Worker's `env` (e.g. `env.EMAIL`). Must match
   * `[A-Za-z][A-Za-z0-9_]*`.
   */
  name: string;
  /**
   * Restrict the Worker to send to a single verified destination
   * address.
   */
  destinationAddress?: string;
  /**
   * Restrict the Worker to send to one of these verified destination
   * addresses.
   */
  allowedDestinationAddresses?: string[];
  /**
   * Restrict the Worker to send from one of these sender addresses. The
   * sender domain must be configured for Email Routing on the account.
   */
  allowedSenderAddresses?: string[];
}

/**
 * Email body shape for the builder-form `send` call. Either `text`,
 * `html`, or both must be provided.
 */
export interface SendEmailMessage {
  from: string | runtime.EmailAddress;
  to: string | string[];
  subject: string;
  replyTo?: string | runtime.EmailAddress;
  cc?: string | string[];
  bcc?: string | string[];
  headers?: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: runtime.EmailAttachment[];
}

export class SendEmailError extends Data.TaggedError("SendEmailError")<{
  message: string;
  cause?: unknown;
}> {}

export interface SendEmailClient {
  /**
   * The raw runtime `SendEmail` binding. Use this when you need to send
   * a pre-built `EmailMessage` from `cloudflare:email`.
   */
  raw: Effect.Effect<runtime.SendEmail, never, WorkerEnvironment>;
  /**
   * Send an email using the builder form. Equivalent to
   * `env.<name>.send({ from, to, subject, text, html, ... })`.
   */
  send(
    message: SendEmailMessage,
  ): Effect.Effect<runtime.EmailSendResult, SendEmailError, WorkerEnvironment>;
  /**
   * Send a raw `EmailMessage` (constructed via `cloudflare:email`).
   * Equivalent to `env.<name>.send(emailMessage)`.
   */
  sendRaw(
    message: runtime.EmailMessage,
  ): Effect.Effect<runtime.EmailSendResult, SendEmailError, WorkerEnvironment>;
}

/**
 * Cloudflare `send_email` Worker binding.
 *
 * Lets a Worker send transactional email via Cloudflare Email Routing.
 * The destination addresses (and optionally the sender domain) must be
 * verified in the Cloudflare dashboard before the binding will deliver.
 *
 * @section Sending Email
 * @example Bind and send to any verified destination
 * ```typescript
 * const email = yield* Cloudflare.SendEmail.bind({ name: "EMAIL" });
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* email.send({
 *       from: "noreply@example.com",
 *       to: "user@example.com",
 *       subject: "Hello",
 *       text: "Hi from Alchemy",
 *     });
 *     return HttpServerResponse.empty({ status: 202 });
 *   }),
 * };
 * ```
 *
 * @example Restrict to a single destination
 * ```typescript
 * const email = yield* Cloudflare.SendEmail.bind({
 *   name: "EMAIL",
 *   destinationAddress: "ops@example.com",
 * });
 * ```
 *
 * @example Restrict to a list of destinations
 * ```typescript
 * const email = yield* Cloudflare.SendEmail.bind({
 *   name: "EMAIL",
 *   allowedDestinationAddresses: [
 *     "ops@example.com",
 *     "alerts@example.com",
 *   ],
 * });
 * ```
 *
 * @example Send a pre-built EmailMessage
 * ```typescript
 * import { EmailMessage } from "cloudflare:email";
 *
 * const email = yield* Cloudflare.SendEmail.bind({ name: "EMAIL" });
 *
 * yield* email.sendRaw(
 *   new EmailMessage("noreply@example.com", "user@example.com", mimeText),
 * );
 * ```
 *
 * @binding
 */
export class SendEmail extends Binding.Service<
  SendEmail,
  (config: SendEmailConfig) => Effect.Effect<SendEmailClient>
>()("Cloudflare.SendEmail") {}

export const SendEmailLive = Layer.effect(
  SendEmail,
  Effect.gen(function* () {
    const bind = yield* SendEmailPolicy;

    return Effect.fn(function* (config: SendEmailConfig) {
      yield* bind(config);
      const env = WorkerEnvironment.asEffect();
      const raw = env.pipe(
        Effect.map(
          (env) => (env as Record<string, runtime.SendEmail>)[config.name],
        ),
      );

      const tryPromise = <T>(
        fn: () => Promise<T>,
      ): Effect.Effect<T, SendEmailError> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new SendEmailError({
              message: error?.message ?? "Unknown send_email error",
              cause: error,
            }),
        });

      return {
        raw,
        send: (message: SendEmailMessage) =>
          raw.pipe(Effect.flatMap((s) => tryPromise(() => s.send(message)))),
        sendRaw: (message: runtime.EmailMessage) =>
          raw.pipe(Effect.flatMap((s) => tryPromise(() => s.send(message)))),
      } satisfies SendEmailClient;
    });
  }),
);

export class SendEmailPolicy extends Binding.Policy<
  SendEmailPolicy,
  (config: SendEmailConfig) => Effect.Effect<void>
>()("Cloudflare.SendEmail") {}

export const SendEmailPolicyLive = SendEmailPolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, config: SendEmailConfig) {
    if (isWorker(host)) {
      yield* host.bind`${config.name}`({
        bindings: [
          {
            type: "send_email",
            name: config.name,
            destinationAddress: config.destinationAddress,
            allowedDestinationAddresses: config.allowedDestinationAddresses,
            allowedSenderAddresses: config.allowedSenderAddresses,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`SendEmail does not support runtime '${host.Type}'`),
      );
    }
  }),
);
