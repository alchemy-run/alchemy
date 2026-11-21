import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Announcements, Deploys, DeployHook } from "./Guild.ts";

/**
 * Answers `/ping` and `/announce`, and posts to #deploys on `POST /deployed`.
 * `/announce` posts through the bot (a bot-token binding); `/deployed`
 * posts through a webhook (only the webhook's token is in the Worker).
 */
export default class Bot extends Cloudflare.Worker<Bot>()(
  "Bot",
  { main: import.meta.url },
  Effect.gen(function* () {
    const announce = yield* Discord.SendMessage(yield* Announcements);
    const postDeploy = yield* Discord.ExecuteWebhook(yield* DeployHook);
    yield* Deploys;

    yield* Discord.ApplicationCommand("Ping", { name: "ping", description: "Replies with pong" });
    yield* Discord.ApplicationCommand("Announce", {
      name: "announce",
      description: "Post an announcement",
      defaultMemberPermissions: Discord.Permissions.ManageMessages,
      options: [{ type: "string", name: "text", description: "What to say", required: true }],
    });

    yield* Discord.consumeInteractions((interaction) =>
      Effect.gen(function* () {
        switch (interaction.data?.name) {
          case "ping":
            return Discord.reply("pong");
          case "announce": {
            const text = String(interaction.data.options?.[0]?.value ?? "");
            yield* announce({ content: text }).pipe(Effect.orDie);
            return Discord.reply("Posted.", { ephemeral: true });
          }
          default:
            return Discord.reply("Unknown command.", { ephemeral: true });
        }
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (
          request.method === "POST" &&
          new URL(request.url, "http://x").pathname === "/deployed"
        ) {
          const { version } = (yield* request.json) as { version: string };
          const message = yield* postDeploy({
            wait: true,
            body: { content: `Deployed ${version}` },
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ messageId: message.id });
        }
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Discord.InteractionsLive, Discord.SendMessageHttp, Discord.ExecuteWebhookHttp),
    ),
  ),
) {}
