import { team } from "@alchemy.run/convex/Credentials";
import * as convex from "@distilled.cloud/convex/convex";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const PREFIX = "alchemy-convex-test-";

/** A deterministic project name for this test and stage. */
export const testName = (suffix: string) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    return `${PREFIX}${suffix}-${stage}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  });

/** The projects with exactly this name. */
export const projectsNamed = Effect.fn(function* (name: string) {
  const teamId = yield* team;
  const items = yield* Stream.runCollect(convex.listProjects.items({ team_id: teamId, q: name }));
  return Array.from(items).filter((project) => project.name === name);
});
