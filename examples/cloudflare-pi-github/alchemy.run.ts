import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Bot from "./src/Bot.ts";
import { Repo } from "./src/Repo.ts";

export default Alchemy.Stack(
  "CloudflarePiGitHub",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Boat.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* Repo;
    const bot = yield* Bot;
    return { url: bot.url, repository: repo.htmlUrl };
  }),
);
