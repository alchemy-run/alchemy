import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as bulkRedirects from "@distilled.cloud/vercel/bulk_redirects";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

/**
 * The stage API requires the owner teamId in the request BODY; the testing
 * profile rides the token's default team (no explicit teamId), so derive it
 * from the host project like the provider does.
 */
const ownerTeamId = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    if (teamId !== undefined) return teamId;
    const project = yield* projects.getProject({ idOrName: projectId });
    return project.accountId;
  });

/** Out-of-band read of the promoted production redirects via distilled. */
const getRedirectsDoc = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* bulkRedirects.getRedirects({
      projectId,
      ...team,
      per_page: 100,
    });
  });

const withHostProject = <A, E, R>(
  hostName: string,
  body: (projectId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const host = yield* projects
      .createProject({ name: hostName, ...team })
      .pipe(
        Effect.map((p) => ({ id: p.id })),
        Effect.catchTag("Conflict", () =>
          projects
            .getProject({ idOrName: hostName, ...team })
            .pipe(Effect.map((p) => ({ id: p.id }))),
        ),
      );
    return yield* body(host.id).pipe(
      Effect.ensuring(
        projects
          .deleteProject({ idOrName: host.id, ...team })
          .pipe(Effect.ignore),
      ),
    );
  });

test.provider(
  "bulk redirects lifecycle: stage+promote, no-op redeploy, drift converge, reset on destroy",
  (stack) =>
    withHostProject("alchemy-test-redirects-life", (projectId) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const props: Vercel.BulkRedirectsProps = {
          projectId,
          name: "alchemy-test-v1",
          redirects: [
            // No statusCode/permanent — pins the platform default (307).
            { source: "/old-home", destination: "/" },
            { source: "/old-blog", destination: "/blog", statusCode: 308 },
            { source: "/campaign", destination: "/sale", permanent: true },
          ],
        };

        const created = yield* stack.deploy(
          Vercel.BulkRedirects("Redirects", props),
        );
        expect(created.projectId).toEqual(projectId);
        expect(created.redirectCount).toEqual(3);
        expect(created.versionId.length).toBeGreaterThan(0);
        expect(created.versionName).toEqual("alchemy-test-v1");

        // Out-of-band: the production document holds all three, staging is
        // empty (the staged version was promoted).
        const doc = yield* getRedirectsDoc(projectId);
        expect(doc.redirects).toHaveLength(3);
        const bySource = new Map(doc.redirects.map((r) => [r.source, r]));
        expect(bySource.get("/old-home")!.statusCode).toEqual(307);
        expect(bySource.get("/old-blog")!.statusCode).toEqual(308);
        expect(bySource.get("/campaign")!.statusCode).toEqual(308);
        const versions = yield* Effect.gen(function* () {
          const team = yield* teamScope;
          return yield* bulkRedirects.getVersions({ projectId, ...team });
        });
        expect(versions.versions.some((v) => v.isStaging === true)).toEqual(
          false,
        );
        expect(versions.versions.find((v) => v.isLive === true)?.id).toEqual(
          created.versionId,
        );

        // Identical redeploy is a true no-op — version untouched.
        const noop = yield* stack.deploy(
          Vercel.BulkRedirects("Redirects", props),
        );
        expect(noop.versionId).toEqual(created.versionId);

        // Drift out-of-band: stage+promote a different document.
        const teamId = yield* ownerTeamId(projectId);
        const driftStaged = yield* bulkRedirects.stageRedirects({
          projectId,
          teamId,
          overwrite: true,
          redirects: [{ source: "/drift", destination: "/elsewhere" }],
        });
        yield* bulkRedirects.updateVersion({
          projectId,
          teamId,
          id: driftStaged.version.id,
          action: "promote",
        });

        // Reconcile with updated props (drop one redirect, change a
        // destination): the engine plans an update and the provider's
        // full-replace converges production — the drift redirect is gone.
        const updated = yield* stack.deploy(
          Vercel.BulkRedirects("Redirects", {
            projectId,
            name: "alchemy-test-v2",
            redirects: [
              { source: "/old-home", destination: "/home" },
              { source: "/old-blog", destination: "/blog" },
            ],
          }),
        );
        expect(updated.redirectCount).toEqual(2);
        expect(updated.versionName).toEqual("alchemy-test-v2");
        expect(updated.versionId).not.toEqual(created.versionId);
        const afterUpdate = yield* getRedirectsDoc(projectId);
        expect(afterUpdate.redirects).toHaveLength(2);
        expect(afterUpdate.redirects.map((r) => r.source).sort()).toEqual([
          "/old-blog",
          "/old-home",
        ]);
        expect(
          afterUpdate.redirects.find((r) => r.source === "/old-home")!
            .destination,
        ).toEqual("/home");

        // Destroy resets the document (empty promoted version).
        yield* stack.destroy();
        const afterDestroy = yield* getRedirectsDoc(projectId);
        expect(afterDestroy.redirects).toHaveLength(0);

        // Destroy again — delete path is idempotent.
        yield* stack.destroy();
      }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing projectId replaces: new project gets the redirects, old project is reset",
  (stack) =>
    withHostProject("alchemy-test-redirects-repl-a", (projectA) =>
      withHostProject("alchemy-test-redirects-repl-b", (projectB) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const created = yield* stack.deploy(
            Vercel.BulkRedirects("Redirects", {
              projectId: projectA,
              redirects: [{ source: "/a", destination: "/b" }],
            }),
          );
          expect(created.projectId).toEqual(projectA);

          const replaced = yield* stack.deploy(
            Vercel.BulkRedirects("Redirects", {
              projectId: projectB,
              redirects: [{ source: "/a", destination: "/b" }],
            }),
          );
          expect(replaced.projectId).toEqual(projectB);

          const onB = yield* getRedirectsDoc(projectB);
          expect(onB.redirects).toHaveLength(1);
          const onA = yield* getRedirectsDoc(projectA);
          expect(onA.redirects).toHaveLength(0);

          yield* stack.destroy();
          const afterDestroy = yield* getRedirectsDoc(projectB);
          expect(afterDestroy.redirects).toHaveLength(0);
        }),
      ),
    ).pipe(logLevel),
  { timeout: 120_000 },
);
