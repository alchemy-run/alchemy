import * as Effect from "effect/Effect";
import { SendEmailBinding, SendEmailTag } from "./SendEmailBinding.ts";

type SendEmailTypeId = typeof SendEmailTypeId;
const SendEmailTypeId = "Cloudflare.SendEmail" as const;

export type SendEmailProps = {
  /**
   * Restrict the Worker to send to a single verified destination address.
   *
   * Mutually exclusive with `allowedDestinationAddresses`. The destination
   * must be a verified address on the account (see {@link EmailAddress}).
   */
  destinationAddress?: string;
  /**
   * Restrict the Worker to send to one of these verified destination addresses.
   *
   * Mutually exclusive with `destinationAddress`.
   */
  allowedDestinationAddresses?: string[];
  /**
   * Restrict the Worker to send from one of these sender addresses.
   *
   * The sender domain must have Email Routing configured (see
   * {@link EmailRouting}) and the addresses must be verified.
   */
  allowedSenderAddresses?: string[];
};

/**
 * A Cloudflare Workers `send_email` binding descriptor.
 *
 * `SendEmail` is a Worker-only binding — it does not create any cloud-side
 * resource. The descriptor names the binding and records optional
 * destination/sender restrictions; the actual `send_email` entry is attached
 * to the Worker via {@link SendEmailBinding}.
 *
 * @resource
 *
 * @section Binding to a Worker
 * @example Send to any verified destination
 * ```typescript
 * const Email = Cloudflare.SendEmail("Email");
 *
 * // in the Worker effect:
 * const email = yield* Cloudflare.SendEmail.bind(Email);
 * yield* email.send({
 *   from: "noreply@example.com",
 *   to: "user@example.com",
 *   subject: "Hello",
 *   text: "Hi from Alchemy",
 * });
 * ```
 *
 * @example Restrict the sender address
 * ```typescript
 * const Ops = Cloudflare.SendEmail("OpsEmail", {
 *   allowedSenderAddresses: ["noreply@example.com"],
 *   destinationAddress: "ops@example.com",
 * });
 * ```
 *
 * @example Sending email with a binding tag
 * ```typescript
 * const Email = Cloudflare.SendEmail("Email", {
 *   destinationAddress: "ops@example.com",
 * });
 *
 * class Mailer extends Cloudflare.SendEmail.Tag<Mailer>()("Mailer", {
 *   resource: Email,
 * }) {}
 *
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const MailerLive = yield* Mailer.layer;
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const mailer = yield* Mailer;
 *         yield* mailer.send({
 *           from: "noreply@example.com",
 *           to: "user@example.com",
 *           subject: "Hello",
 *           text: "Hi from Alchemy",
 *         });
 *         return new Response("sent");
 *       }).pipe(Effect.provide(MailerLive)),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.SendEmailBindingLive)),
 * );
 * ```
 */
export type SendEmail = SendEmailProps & {
  kind: SendEmailTypeId;
  name: string;
};

export const isSendEmail = (value: unknown): value is SendEmail =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as SendEmail).kind === SendEmailTypeId;

export const SendEmail: {
  (id: string, props?: SendEmailProps): Effect.Effect<SendEmail>;
  /**
   * Bind this `send_email` descriptor to the surrounding Worker. Returns a
   * typed runtime client for sending email.
   */
  bind: typeof SendEmailBinding.bind;
  Tag: typeof SendEmailTag;
} = Object.assign(
  Effect.fnUntraced(function* (id: string, props?: SendEmailProps) {
    return {
      kind: SendEmailTypeId,
      name: id,
      destinationAddress: props?.destinationAddress,
      allowedDestinationAddresses: props?.allowedDestinationAddresses,
      allowedSenderAddresses: props?.allowedSenderAddresses,
    } satisfies SendEmail;
  }),
  {
    bind: SendEmailBinding.bind,
    Tag: SendEmailTag,
  },
);
