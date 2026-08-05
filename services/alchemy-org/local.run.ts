/**
 * The review bot's LOCAL deploy: the sandbox repository plus
 * {@link ReviewBotServer} (src/Server.ts) as a detached local process
 * — KernelMemory, REST polling, bun:sqlite, per-PR worktrees, UI
 * included. Nothing on Cloudflare.
 *
 * Run with the operator's shell env carrying `ANTHROPIC_API_KEY`
 * (e.g. `doppler run -- bun alchemy deploy ./local.run.ts`); GitHub
 * credentials resolve from the alchemy profile.
 */
import * as Alchemy from "alchemy";
import * as GitHub from "alchemy/GitHub";
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/Repos.ts";
import ReviewBotServer from "./src/Server.ts";

export default Alchemy.Stack(
  "ReviewBotLocal",
  {
    providers: Layer.mergeAll(GitHub.providers(), Local.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const bot = yield* ReviewBotServer;
    return {
      repository: repo.fullName,
      url: bot.url,
    };
  }),
);
