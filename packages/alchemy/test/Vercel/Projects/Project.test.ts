/**
 * Vercel Project lifecycle tests.
 *
 * NOTE: the standing Vercel test team is currently SUSPENDED (billing
 * expired) — every resource-creating call answers a typed
 * `PaymentRequired` (402 `resource_creation_blocked`). These tests are
 * written and ready to run once billing is reactivated; until then they
 * fail fast with that typed tag.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Poll (bounded) until the project is gone — typed wait-until-gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "create, update, and delete a project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Project("DefaultProject");
        }),
      );

      expect(created.projectId).toBeDefined();
      expect(created.projectName).toBeDefined();

      // Out-of-band verification via distilled.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const fetched = yield* projects.getProject({
        idOrName: created.projectId,
        teamId,
      });
      expect(fetched.id).toEqual(created.projectId);
      expect(fetched.name).toEqual(created.projectName);

      // The ownership stamp (ALCHEMY_META) must be present on the project.
      const envs = yield* projects.filterProjectEnvs({
        idOrName: created.projectId,
        teamId,
        decrypt: "true",
      });
      const rows = Array.isArray(envs)
        ? envs
        : typeof envs === "object" && envs !== null && "envs" in envs
          ? envs.envs
          : [];
      expect(
        rows.some((row: { key: string }) => row.key === "ALCHEMY_META"),
      ).toBe(true);

      // Update: settings converge without replacement.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Project("DefaultProject", {
            nodeVersion: "22.x",
          });
        }),
      );
      expect(updated.projectId).toEqual(created.projectId);
      expect(updated.nodeVersion).toEqual("22.x");

      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "project with default props does not change on redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(Vercel.Project("StableProject"));
      const created = yield* deploy;
      const redeployed = yield* deploy;

      expect(redeployed.projectId).toEqual(created.projectId);
      expect(redeployed.projectName).toEqual(created.projectName);

      yield* stack.destroy();
      yield* expectProjectGone(created.projectId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
