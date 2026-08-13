/**
 * The org's LOCAL deploy: the sandbox repository plus
 * {@link OrgServer} (src/Server.ts) as a detached local process —
 * driver over sqlite storage, GitHub REST polling, per-PR worktrees,
 * the engineer's fixed desk, UI included. Nothing in the cloud.
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
import OrgServer from "./src/Server.ts";

export default Alchemy.Stack(
  "Engineer",
  {
    providers: Layer.mergeAll(GitHub.providers(), Local.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const org = yield* OrgServer;
    return {
      repository: repo.fullName,
      url: org.url,
    };
  }),
);
