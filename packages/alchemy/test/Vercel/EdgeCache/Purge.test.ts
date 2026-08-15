import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
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
const PROBE_PROJECT = "alchemy-test-edge-cache";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId;
});

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

test.provider(
  "purge actions succeed against a live project",
  () =>
    Effect.gen(function* () {
      const projectId = yield* ensureProbeProject;

      // Soft invalidation by tag — accepts both a single tag and a list.
      yield* Vercel.invalidateEdgeCacheByTags(projectId, "alchemy-test-tag");
      yield* Vercel.invalidateEdgeCacheByTags(
        { projectId },
        ["alchemy-test-tag-a", "alchemy-test-tag-b"],
        { target: "production" },
      );

      // Hard delete by tag with a revalidation deadline.
      yield* Vercel.dangerouslyDeleteEdgeCacheByTags(
        projectId,
        "alchemy-test-tag",
        { revalidationDeadlineSeconds: 60 },
      );

      // Source-image variants.
      yield* Vercel.invalidateEdgeCacheBySrcImages(projectId, [
        "https://example.com/alchemy-test.png",
      ]);
      yield* Vercel.dangerouslyDeleteEdgeCacheBySrcImages(projectId, [
        "https://example.com/alchemy-test.png",
      ]);
    }).pipe(Effect.ensuring(deleteProbeProject.pipe(Effect.ignore)), logLevel),
  { timeout: 120_000 },
);

test.provider(
  "purge against a nonexistent project fails with typed NotFound",
  () =>
    Effect.gen(function* () {
      const purged = yield* Effect.result(
        Vercel.invalidateEdgeCacheByTags(
          "prj_nonexistent000000000000000",
          "alchemy-test-tag",
        ),
      );
      expect(Result.isFailure(purged)).toBe(true);
      if (Result.isFailure(purged)) {
        expect(purged.failure._tag).toBe("NotFound");
      }
    }).pipe(logLevel),
);
