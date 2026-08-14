import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projectRoutes from "@distilled.cloud/vercel/project_routes";
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

/** Out-of-band read of the current routes document via distilled. */
const getRoutesDoc = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* projectRoutes.getRoutes({ projectId, ...team });
  });

const getVersions = (projectId: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    return yield* projectRoutes.getRouteVersions({ projectId, ...team });
  });

/**
 * Create (or reuse, after an interrupted run) a host project out-of-band via
 * distilled — deterministic name — run `body` against it, and always delete
 * the project again.
 */
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

const redirectRule = (
  dest: string,
  status: number = 308,
): Vercel.ProjectRouteRule => ({
  id: "legacy",
  name: "Legacy redirect",
  route: { src: "/old-path", dest, status },
});

const rewriteRule: Vercel.ProjectRouteRule = {
  id: "docs",
  name: "Docs rewrite",
  enabled: false,
  route: { src: "/docs/(.*)", dest: "/documentation/$1" },
};

test.provider(
  "routes lifecycle: stage+promote, no-op redeploy, drift converge, draft replace, reset on destroy",
  (stack) =>
    withHostProject("alchemy-test-routes-life", (projectId) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const props: Vercel.ProjectRoutesProps = {
          projectId,
          routes: [redirectRule("/new-path"), rewriteRule],
        };

        const created = yield* stack.deploy(
          Vercel.ProjectRoutes("Routes", props),
        );
        expect(created.projectId).toEqual(projectId);
        expect(created.ruleCount).toEqual(2);
        expect(created.versionId.length).toBeGreaterThan(0);
        expect(created.routes.map((r) => r.id)).toEqual(["legacy", "docs"]);
        expect(created.routes[0]!.enabled).toEqual(true);
        expect(created.routes[1]!.enabled).toEqual(false);
        expect(created.routes[0]!.routeType).toEqual("redirect");

        // Out-of-band: the document is PROMOTED (no staging version left).
        const versions = yield* getVersions(projectId);
        expect(versions.versions.some((v) => v.isStaging === true)).toEqual(
          false,
        );
        const doc = yield* getRoutesDoc(projectId);
        expect(doc.routes).toHaveLength(2);
        expect(doc.routes.every((r) => r.staged !== true)).toEqual(true);

        // Identical redeploy is a true no-op — version untouched.
        const noop = yield* stack.deploy(Vercel.ProjectRoutes("Routes", props));
        expect(noop.versionId).toEqual(created.versionId);

        // Drift out-of-band: stage+promote a different document.
        const team = yield* teamScope;
        const driftStaged = yield* projectRoutes.stageRoutes({
          projectId,
          ...team,
          overwrite: true,
          routes: [
            {
              id: "drift",
              name: "Drift rule",
              route: { src: "/drift", dest: "/elsewhere" },
            },
          ],
        });
        yield* projectRoutes.updateRouteVersions({
          projectId,
          ...team,
          id: driftStaged.version.id,
          action: "promote",
        });

        // Reconcile with updated props: the engine plans an update (props
        // changed) and the provider's full-replace converges production —
        // the drift rule is gone, the desired document is live.
        const converged = yield* stack.deploy(
          Vercel.ProjectRoutes("Routes", {
            projectId,
            routes: [redirectRule("/moved"), rewriteRule],
          }),
        );
        expect(converged.ruleCount).toEqual(2);
        expect(converged.versionId).not.toEqual(created.versionId);
        const afterConverge = yield* getRoutesDoc(projectId);
        expect(afterConverge.routes.map((r) => r.id)).toEqual([
          "legacy",
          "docs",
        ]);
        expect(
          afterConverge.routes[0]!.rawDest ??
            afterConverge.routes[0]!.route.dest,
        ).toEqual("/moved");

        // A foreign unpromoted draft is replaced by the next reconcile that
        // writes (staging is a single slot owned by the resource).
        yield* projectRoutes.stageRoutes({
          projectId,
          ...team,
          overwrite: true,
          routes: [
            {
              id: "foreign-draft",
              name: "Foreign draft",
              route: { src: "/draft", dest: "/nowhere" },
            },
          ],
        });
        const afterDraft = yield* stack.deploy(
          Vercel.ProjectRoutes("Routes", {
            projectId,
            routes: [redirectRule("/moved-again", 307), rewriteRule],
          }),
        );
        expect(afterDraft.ruleCount).toEqual(2);
        const postDraftVersions = yield* getVersions(projectId);
        expect(
          postDraftVersions.versions.some((v) => v.isStaging === true),
        ).toEqual(false);
        const postDraftDoc = yield* getRoutesDoc(projectId);
        expect(postDraftDoc.routes.map((r) => r.id)).toEqual([
          "legacy",
          "docs",
        ]);
        expect(
          postDraftDoc.routes[0]!.rawDest ?? postDraftDoc.routes[0]!.route.dest,
        ).toEqual("/moved-again");

        // Destroy resets the document (empty promoted version).
        yield* stack.destroy();
        const afterDestroy = yield* getRoutesDoc(projectId);
        expect(afterDestroy.routes).toHaveLength(0);

        // Destroy again — delete path is idempotent.
        yield* stack.destroy();
      }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing projectId replaces: new project gets the rules, old project is reset",
  (stack) =>
    withHostProject("alchemy-test-routes-repl-a", (projectA) =>
      withHostProject("alchemy-test-routes-repl-b", (projectB) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const created = yield* stack.deploy(
            Vercel.ProjectRoutes("Routes", {
              projectId: projectA,
              routes: [redirectRule("/new-path")],
            }),
          );
          expect(created.projectId).toEqual(projectA);

          const replaced = yield* stack.deploy(
            Vercel.ProjectRoutes("Routes", {
              projectId: projectB,
              routes: [redirectRule("/new-path")],
            }),
          );
          expect(replaced.projectId).toEqual(projectB);

          const onB = yield* getRoutesDoc(projectB);
          expect(onB.routes).toHaveLength(1);
          const onA = yield* getRoutesDoc(projectA);
          expect(onA.routes).toHaveLength(0);

          yield* stack.destroy();
          const afterDestroy = yield* getRoutesDoc(projectB);
          expect(afterDestroy.routes).toHaveLength(0);
        }),
      ),
    ).pipe(logLevel),
  { timeout: 120_000 },
);
