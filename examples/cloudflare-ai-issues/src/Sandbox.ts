import * as AIBoat from "@alchemy.run/ai/Boat";
import * as Boat from "@alchemy.run/boat";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Repo } from "./Repo.ts";

/**
 * One Boat sandbox per session, started from a snapshot that already has
 * the repository cloned at `~/repo`.
 */
export const SandboxLive = AIBoat.Sandboxes(
  Effect.gen(function* () {
    const repo = yield* Repo;
    return yield* Boat.Snapshot("Checkout", {
      run: [Output.interpolate`git clone ${repo.cloneUrl} ~/repo`],
    });
  }),
);
