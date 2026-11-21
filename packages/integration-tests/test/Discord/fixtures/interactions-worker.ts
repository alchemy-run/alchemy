import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

// Answers `/ping` with "pong". Deploying it points the application's
// interactions endpoint at this Worker; Discord's verification PING must be
// answered for that deploy to succeed.
export default class DiscordInteractionsWorker extends Cloudflare.Worker<DiscordInteractionsWorker>()(
  "DiscordInteractionsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* Discord.consumeInteractions((interaction) =>
      Effect.succeed(
        interaction.data?.name?.startsWith("ping")
          ? Discord.reply("pong")
          : Discord.reply("unknown", { ephemeral: true }),
      ),
    );
    yield* Discord.consumeWebhookEvents({ types: ["APPLICATION_AUTHORIZED"] }, (event) =>
      Effect.log(`discord event ${event.type}`),
    );
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide(Layer.mergeAll(Discord.InteractionsLive, Discord.WebhookEventsLive))),
) {}
