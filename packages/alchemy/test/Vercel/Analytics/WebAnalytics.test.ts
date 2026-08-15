import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import * as webAnalytics from "@distilled.cloud/vercel/web_analytics";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic out-of-band probe project — same name on every run.
const PROBE_PROJECT = "alchemy-test-web-analytics";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId;
});

/** Create (or re-use) the out-of-band probe project. */
const ensureProbeProject = Effect.gen(function* () {
  const teamId = yield* teamScopeOf;
  return yield* projects.getProject({ idOrName: PROBE_PROJECT, teamId }).pipe(
    Effect.map((p) => p.id),
    Effect.catchTag("NotFound", () =>
      projects
        .createProject({ name: PROBE_PROJECT, teamId })
        .pipe(Effect.map((p) => p.id)),
    ),
  );
});

const deleteProbeProject = Effect.gen(function* () {
  const teamId = yield* teamScopeOf;
  yield* projects
    .deleteProject({ idOrName: PROBE_PROJECT, teamId })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
});

const readProbeAnalytics = Effect.gen(function* () {
  const teamId = yield* teamScopeOf;
  const project = yield* projects.getProject({
    idOrName: PROBE_PROJECT,
    teamId,
  });
  return project.webAnalytics;
});

test.provider(
  "enable, no-op redeploy, and disable web analytics on a probe project",
  (stack) =>
    Effect.gen(function* () {
      const projectId = yield* ensureProbeProject;

      yield* stack.destroy();

      // Enable analytics via the resource.
      const analytics = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.WebAnalytics("Analytics", {
            project: PROBE_PROJECT,
          });
        }),
      );
      expect(analytics.projectId).toEqual(projectId);
      expect(analytics.analyticsId).toBeDefined();
      expect(analytics.enabledAt).toBeDefined();

      // Out-of-band verification via distilled: the project reports
      // analytics as enabled.
      const observed = yield* readProbeAnalytics;
      expect(observed?.id).toEqual(analytics.analyticsId);
      expect(observed?.enabledAt).toBeDefined();

      // Idempotent redeploy — same analytics instance, no re-toggle.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.WebAnalytics("Analytics", {
            project: PROBE_PROJECT,
          });
        }),
      );
      expect(again.analyticsId).toEqual(analytics.analyticsId);

      // Destroy toggles analytics back off (the project itself remains).
      yield* stack.destroy();
      const after = yield* readProbeAnalytics;
      expect(after?.disabledAt).toBeDefined();
      expect((after?.enabledAt ?? 0) <= (after?.disabledAt ?? 0)).toBe(true);
    }).pipe(Effect.ensuring(deleteProbeProject.pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

// Pins the distilled patch: toggling analytics on a nonexistent project
// answers the TYPED NotFound tag (the unpatched op lacked 404 + teamId).
test.provider("toggle on a nonexistent project fails with typed NotFound", () =>
  Effect.gen(function* () {
    const teamId = yield* teamScopeOf;
    const toggled = yield* Effect.result(
      webAnalytics.createWebInsightsToggle({
        projectId: "prj_nonexistent000000000000000",
        value: false,
        teamId,
      }),
    );
    expect(Result.isFailure(toggled)).toBe(true);
    if (Result.isFailure(toggled)) {
      expect(toggled.failure._tag).toBe("NotFound");
    }
  }).pipe(logLevel),
);
