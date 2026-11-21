import * as discord from "@distilled.cloud/discord/discord";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { WebhookAccess } from "./DiscordBindings.ts";
import type { Providers } from "./Providers.ts";

/**
 * An interaction Discord delivered: a slash or context-menu command, a
 * component click, a modal submit or an autocomplete request
 * (https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object).
 */
export interface Interaction {
  /** Interaction id. */
  readonly id: string;
  /** Application id. */
  readonly application_id: string;
  /**
   * 2 application command, 3 message component, 4 autocomplete,
   * 5 modal submit (1, PING, is answered for you).
   */
  readonly type: 2 | 3 | 4 | 5;
  /** Token for the response and followups; valid for 15 minutes. */
  readonly token: string;
  /** Command name and options, component `custom_id`, or modal values. */
  readonly data?: {
    readonly id?: string;
    readonly name?: string;
    readonly type?: number;
    readonly custom_id?: string;
    readonly component_type?: number;
    readonly values?: ReadonlyArray<string>;
    readonly options?: ReadonlyArray<InteractionOption>;
    readonly components?: ReadonlyArray<unknown>;
    readonly target_id?: string;
    readonly resolved?: unknown;
  };
  /** Guild it came from, if any. */
  readonly guild_id?: string;
  /** Channel it came from. */
  readonly channel_id?: string;
  /** Invoking member, in a guild. */
  readonly member?: { readonly user: InteractionUser; readonly roles: ReadonlyArray<string> };
  /** Invoking user, in a DM. */
  readonly user?: InteractionUser;
  /** Message a component is attached to. */
  readonly message?: { readonly id: string; readonly content?: string };
  /** Invoking user's locale. */
  readonly locale?: string;
  /** Guild's locale. */
  readonly guild_locale?: string;
  /** Permissions the app has in the channel, as a decimal string. */
  readonly app_permissions?: string;
}

export interface InteractionUser {
  readonly id: string;
  readonly username: string;
  readonly global_name?: string | null;
}

export interface InteractionOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly focused?: boolean;
  readonly options?: ReadonlyArray<InteractionOption>;
}

/**
 * What the handler answers with: an interaction callback
 * (https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object).
 * Common ones: `{ type: 4, data: { content } }` replies, `{ type: 5 }` defers
 * the reply (finish it with {@link editOriginalResponse}), `{ type: 6 }`
 * acknowledges a component, `{ type: 7, data }` updates its message,
 * `{ type: 8, data: { choices } }` answers autocomplete, `{ type: 9, data }`
 * opens a modal.
 */
export type InteractionResponse = discord.CreateInteractionResponseRequestBody;

/** A reply with `content` (callback type 4). Pass `ephemeral` to show it only to the invoker. */
export const reply = (
  content: string,
  options?: { readonly ephemeral?: boolean },
): InteractionResponse =>
  ({
    type: 4,
    data: { content, flags: options?.ephemeral ? 64 : undefined },
  }) as InteractionResponse;

/** Defer the reply (callback type 5); finish with {@link editOriginalResponse}. */
export const deferReply = (options?: { readonly ephemeral?: boolean }): InteractionResponse =>
  ({ type: 5, data: { flags: options?.ephemeral ? 64 : undefined } }) as InteractionResponse;

export interface InteractionsProps {
  /**
   * Path on the host Discord delivers to.
   * @default "/__alchemy/discord/interactions"
   */
  path?: string;
}

/**
 * Receive Discord interactions on the host this runs in.
 *
 * Call it in the construction phase of a host (a Cloudflare Worker) with a
 * handler that answers each interaction. Deploying it registers the host's
 * URL as the application's interactions endpoint; Discord verifies the URL
 * with a signed PING, which the event source answers. Every request is
 * verified against the application's public key and refused with 401 when
 * the signature doesn't match. Provide `Discord.InteractionsLive`.
 *
 * Discord waits 3 seconds for the answer. For slower work, answer
 * {@link deferReply} and finish later with {@link editOriginalResponse}.
 *
 * ### Answering Slash Commands
 * **Example:** A ping command on a Worker
 * ```typescript
 * export default class Bot extends Cloudflare.Worker<Bot>()(
 *   "Bot",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Discord.ApplicationCommand("Ping", { name: "ping", description: "Pong!" });
 *     yield* Discord.consumeInteractions((interaction) =>
 *       Effect.succeed(
 *         interaction.data?.name === "ping"
 *           ? Discord.reply("pong")
 *           : Discord.reply("unknown command", { ephemeral: true }),
 *       ),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Discord.InteractionsLive)),
 * ) {}
 * ```
 *
 * **Example:** Defer, then edit the reply
 * ```typescript
 * yield* Discord.consumeInteractions((interaction) =>
 *   Effect.gen(function* () {
 *     yield* Effect.forkDetach(
 *       Discord.editOriginalResponse(interaction, { content: yield* slowAnswer }),
 *     );
 *     return Discord.deferReply();
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Interaction
 */
export function consumeInteractions<Req = never>(
  handler: (interaction: Interaction) => Effect.Effect<InteractionResponse, never, Req | Providers>,
): Effect.Effect<void, never, Interactions>;
export function consumeInteractions<Req = never>(
  props: InteractionsProps,
  handler: (interaction: Interaction) => Effect.Effect<InteractionResponse, never, Req | Providers>,
): Effect.Effect<void, never, Interactions>;
export function consumeInteractions<Req = never>(
  propsOrHandler:
    | InteractionsProps
    | ((interaction: Interaction) => Effect.Effect<InteractionResponse, never, Req | Providers>),
  maybeHandler?: (
    interaction: Interaction,
  ) => Effect.Effect<InteractionResponse, never, Req | Providers>,
) {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as InteractionsProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  return Interactions.use((source) => source(props, handler));
}

export type InteractionsService = <Req = never>(
  props: InteractionsProps,
  handler: (interaction: Interaction) => Effect.Effect<InteractionResponse, never, Req>,
) => Effect.Effect<void, never, never>;

export class Interactions extends Context.Service<Interactions, InteractionsService>()(
  "Discord.Interactions",
) {}

export const interactionsPath = (props: InteractionsProps) =>
  props.path ?? "/__alchemy/discord/interactions";

const ids = (interaction: Interaction) => ({
  webhook_id: interaction.application_id,
  webhook_token: Redacted.make(interaction.token),
});

/** Edit the original response to an interaction (finishes a deferred reply). */
export const editOriginalResponse = (
  interaction: Interaction,
  body: Omit<discord.UpdateOriginalWebhookMessageRequest, "webhook_id" | "webhook_token">,
) =>
  Effect.flatMap(WebhookAccess, (authorize) =>
    authorize(discord.updateOriginalWebhookMessage({ ...body, ...ids(interaction) })),
  );

/** Read the original response to an interaction. */
export const getOriginalResponse = (interaction: Interaction) =>
  Effect.flatMap(WebhookAccess, (authorize) =>
    authorize(discord.getOriginalWebhookMessage(ids(interaction))),
  );

/** Delete the original response to an interaction. */
export const deleteOriginalResponse = (interaction: Interaction) =>
  Effect.flatMap(WebhookAccess, (authorize) =>
    authorize(discord.deleteOriginalWebhookMessage(ids(interaction))),
  );

/** Send a followup message to an interaction (up to 15 minutes after it). */
export const sendFollowup = (
  interaction: Interaction,
  body: discord.ExecuteWebhookRequest["body"],
) =>
  Effect.flatMap(WebhookAccess, (authorize) =>
    authorize(discord.executeWebhook({ ...ids(interaction), wait: true, body })),
  );

/**
 * Answer an interaction out of band (instead of returning the answer from
 * the handler), e.g. from a Gateway bot.
 */
export const respondToInteraction = (interaction: Interaction, body: InteractionResponse) =>
  Effect.flatMap(WebhookAccess, (authorize) =>
    authorize(
      discord.createInteractionResponse({
        interaction_id: interaction.id,
        interaction_token: Redacted.make(interaction.token),
        body,
      }),
    ),
  );
