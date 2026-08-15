import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as domains from "@distilled.cloud/vercel/domains";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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
 * Create (or reuse, after an interrupted run) a host project out-of-band via
 * distilled — deterministic name — run `body` against it, and always delete
 * the project again. Attaching `*.{apexDomain}` auto-adds the apex domain to
 * the team's domain list, so it is deleted on the way out as well.
 */
const withHostProject = <A, E, R>(
  hostName: string,
  apexDomain: string,
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
      Effect.ensuring(
        Effect.gen(function* () {
          const t = yield* teamScope;
          yield* domains.deleteDomain({ domain: apexDomain, ...t }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.ignore,
          );
        }),
      ),
    );
  });

/** Out-of-band: find the project domain row by name via the list endpoint. */
const findProjectDomain = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const team = yield* teamScope;
    const body = yield* projects.getProjectDomains({
      idOrName: projectId,
      limit: 100,
      ...team,
    });
    return body.domains.find((d) => d.name === name);
  });

test.provider(
  "project domain lifecycle: attach, sync redirect, detach",
  (stack) =>
    withHostProject(
      "alchemy-test-domains-pd-life",
      "alchemy-vercel-test-pd.example",
      (projectId) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const APP = "app.alchemy-vercel-test-pd.example";
          const WWW = "www.alchemy-vercel-test-pd.example";

          const deployPair = (withRedirect: boolean) =>
            stack.deploy(
              Effect.gen(function* () {
                const www = yield* Vercel.ProjectDomain("Www", {
                  project: projectId,
                  name: WWW,
                });
                const app = yield* Vercel.ProjectDomain("App", {
                  project: projectId,
                  name: APP,
                  ...(withRedirect
                    ? { redirect: WWW, redirectStatusCode: 308 as const }
                    : {}),
                });
                return { app, www };
              }),
            );

          const created = yield* deployPair(false);
          expect(created.app.projectId).toEqual(projectId);
          expect(created.app.name).toEqual(APP);
          expect(created.app.apexName).toEqual(
            "alchemy-vercel-test-pd.example",
          );
          // The apex was auto-added to the same team, so the attachment
          // verifies immediately.
          expect(created.app.verified).toEqual(true);
          expect(created.app.redirect).toBeUndefined();

          // Out-of-band verification via distilled.
          const observed = yield* findProjectDomain(projectId, APP);
          expect(observed).toBeDefined();
          expect(observed!.verified).toEqual(true);

          // Sync: add a redirect from app -> www.
          const updated = yield* deployPair(true);
          expect(updated.app.redirect).toEqual(WWW);
          expect(updated.app.redirectStatusCode).toEqual(308);

          const observedRedirect = yield* findProjectDomain(projectId, APP);
          expect(observedRedirect!.redirect).toEqual(WWW);
          expect(observedRedirect!.redirectStatusCode).toEqual(308);

          // Redeploy the same shape — converges without churn.
          const noop = yield* deployPair(true);
          expect(noop.app.redirect).toEqual(WWW);

          yield* stack.destroy();

          // Both attachments are detached (bounded wait).
          const gone = yield* Effect.gen(function* () {
            const app = yield* findProjectDomain(projectId, APP);
            const www = yield* findProjectDomain(projectId, WWW);
            return app === undefined && www === undefined
              ? ("gone" as const)
              : ("found" as const);
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (s) => s === "gone",
              times: 10,
            }),
          );
          expect(gone).toEqual("gone");

          // Destroy again — delete path is idempotent.
          yield* stack.destroy();
        }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replaces the attachment when the domain name changes",
  (stack) =>
    withHostProject(
      "alchemy-test-domains-pd-repl",
      "alchemy-vercel-test-pdr.example",
      (projectId) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const NAME_A = "a.alchemy-vercel-test-pdr.example";
          const NAME_B = "b.alchemy-vercel-test-pdr.example";

          const deployName = (name: string) =>
            stack.deploy(
              Vercel.ProjectDomain("Attached", { project: projectId, name }),
            );

          const created = yield* deployName(NAME_A);
          expect(created.name).toEqual(NAME_A);

          const replaced = yield* deployName(NAME_B);
          expect(replaced.name).toEqual(NAME_B);

          const onB = yield* findProjectDomain(projectId, NAME_B);
          expect(onB).toBeDefined();
          const onA = yield* findProjectDomain(projectId, NAME_A);
          expect(onA).toBeUndefined();

          yield* stack.destroy();
          const afterDestroy = yield* findProjectDomain(projectId, NAME_B);
          expect(afterDestroy).toBeUndefined();
        }),
    ).pipe(logLevel),
  { timeout: 120_000 },
);
