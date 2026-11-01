import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { Credentials, fromDeployment, team } from "@alchemy.run/convex/Credentials";
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

/** Run a Deployment API call against one deployment with the test token. */
export const onDeployment = <A, E, R>(url: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { token } = yield* yield* Credentials;
    return yield* effect.pipe(Effect.provide(fromDeployment({ url, token })));
  });

/** The fixture Convex app. */
export const FIXTURE_DIR = NodePath.join(import.meta.dirname, "fixtures/backend");

/** Run the Convex CLI in the fixture app. The key goes through the environment, never argv. */
export const convexCli = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.sync(() => {
    const cli = NodePath.join(import.meta.dirname, "../../node_modules/.bin/convex");
    const result = NodeChildProcess.spawnSync(cli, [...args], {
      cwd: FIXTURE_DIR,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  });
