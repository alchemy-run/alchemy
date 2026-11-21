/**
 * Shared scaffolding for the Discord `*Http` binding layers: one maker per
 * kind of bound resource. Each resolves the host's access once at layer
 * build, the bound resource's ids as runtime accessors, and injects them into
 * the distilled call. Not exported from the package barrel.
 */
import type { DiscordOpContext } from "@distilled.cloud/discord";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Application } from "../Application.ts";
import type { Channel } from "../Channel.ts";
import { BotAccess, WebhookAccess } from "../DiscordBindings.ts";
import type { Guild } from "../Guild.ts";
import type { Webhook } from "../Webhook.ts";

type Call<Ids, Req, A, E> = (ids: Ids, request: Req) => Effect.Effect<A, E, DiscordOpContext>;

/** A binding on a {@link Channel}: injects `channel_id`. */
export const channel = <Req, A, E>(name: string, call: Call<string, Req, A, E>) =>
  Effect.gen(function* () {
    const access = yield* BotAccess;
    return Effect.fn(function* (target: Channel) {
      const authorize = yield* access();
      const channelId = yield* target.channelId;
      return Effect.fn(`Discord.${name}`)(function* (request?: Req) {
        return yield* authorize(call(yield* channelId, request ?? ({} as Req)));
      });
    });
  });

/** A binding on a {@link Guild}: injects `guild_id`. */
export const guild = <Req, A, E>(name: string, call: Call<string, Req, A, E>) =>
  Effect.gen(function* () {
    const access = yield* BotAccess;
    return Effect.fn(function* (target: Guild) {
      const authorize = yield* access();
      const guildId = yield* target.guildId;
      return Effect.fn(`Discord.${name}`)(function* (request?: Req) {
        return yield* authorize(call(yield* guildId, request ?? ({} as Req)));
      });
    });
  });

/** A binding on the {@link Application}: injects `application_id`. */
export const application = <Req, A, E>(name: string, call: Call<string, Req, A, E>) =>
  Effect.gen(function* () {
    const access = yield* BotAccess;
    return Effect.fn(function* (target: Application) {
      const authorize = yield* access();
      const applicationId = yield* target.applicationId;
      return Effect.fn(`Discord.${name}`)(function* (request?: Req) {
        return yield* authorize(call(yield* applicationId, request ?? ({} as Req)));
      });
    });
  });

/**
 * A binding on a {@link Webhook}: injects `webhook_id` and `webhook_token`.
 * Only the webhook's token is bound into the host, never the bot token.
 */
export const webhook = <Req, A, E>(
  name: string,
  call: Call<{ id: string; token: Redacted.Redacted<string> }, Req, A, E>,
) =>
  Effect.gen(function* () {
    const authorize = yield* WebhookAccess;
    return Effect.fn(function* (target: Webhook) {
      const webhookId = yield* target.webhookId;
      const token = yield* target.token;
      return Effect.fn(`Discord.${name}`)(function* (request?: Req) {
        const ids = { id: yield* webhookId, token: yield* token };
        return yield* authorize(call(ids, request ?? ({} as Req)));
      });
    });
  });
