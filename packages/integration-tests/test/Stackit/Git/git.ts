import { expect } from "@alchemy.run/test";
import { ForgejoCredentials, forgejoCredentialsOf } from "@distilled.cloud/stackit/Forgejo";
import * as git from "@distilled.cloud/stackit/git";
import * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Shared fixtures of the STACKIT Git suites.
 *
 * Every suite needs a live instance, billed per started hour, so all of them are gated behind the
 * provider-wide slow flag `STACKIT_TEST_SLOW`.
 */
export const slow = !process.env.STACKIT_TEST_SLOW;

/** A local user's password. Throwaway: the instance goes with the test. */
export const TEST_PASSWORD = "alchemy-Test-Passw0rd-1";

/** The instance's state as STACKIT reports it, or `"gone"` (typed `NotFound`). */
export const observeInstance = (projectId: string, instanceId: string) =>
  git.getInstance({ projectId, instanceId }).pipe(
    Effect.map((instance): git.Instance | "gone" => instance),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

/** Bounded check that an observation reports the object gone. */
export const expectGone = <A, E, R>(read: Effect.Effect<A | "gone", E, R>) =>
  read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (state) => state === "gone",
      times: 60,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** Run Forgejo operations out of band, as a local user of a deployed instance. */
export const withUser = <A, E, R>(
  instanceUrl: string,
  username: string,
  use: Effect.Effect<A, E, R>,
) =>
  use.pipe(
    Effect.provideService(
      ForgejoCredentials,
      forgejoCredentialsOf({
        instanceUrl,
        auth: { username, password: Redacted.make(TEST_PASSWORD) },
      }),
    ),
  );

/** The repository as Forgejo reports it, or `"gone"` (typed `NotFound`). */
export const observeRepository = (owner: string, repo: string) =>
  forgejo.getRepository({ owner, repo }).pipe(
    Effect.map((repository): forgejo.Repository | "gone" => repository),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );
