import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Bot from "./src/Bot.ts";
import { Deploys } from "./src/Guild.ts";

export default Alchemy.Stack(
  "DiscordBotExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Discord.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bot = yield* Bot;
    const deploys = yield* Deploys;
    return { url: bot.url.as<string>(), deploysChannelId: deploys.channelId };
  }),
);
