import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as featureFlags from "@distilled.cloud/vercel/feature_flags";
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

// Deterministic host-project names — one per test so concurrently running
// tests never fight over a fixture.
const HOST_LIFECYCLE = "alchemy-featureflags-host-lifecycle";
const HOST_SLUG = "alchemy-featureflags-host-slug";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Out-of-band host-project fixture (NOT the Vercel.Project resource — these
// tests must not depend on a concurrently-owned provider). Delete-if-exists
// first so an interrupted previous run can't wedge the deterministic name.
const ensureHostProject = (name: string, scope: { teamId?: string }) =>
  Effect.gen(function* () {
    yield* projects
      .deleteProject({ idOrName: name, ...scope })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const created = yield* projects.createProject({ name, ...scope });
    return created.id;
  });

// Finalizer-safe (used with `Effect.ensuring`): never fails.
const deleteHostProject = (name: string, scope: { teamId?: string }) =>
  projects.deleteProject({ idOrName: name, ...scope }).pipe(Effect.ignore);

/** Bounded typed wait-until-gone. */
const expectFlagGone = (
  projectId: string,
  flagId: string,
  scope: { teamId?: string },
) =>
  Effect.gen(function* () {
    const gone = yield* featureFlags
      .getFlag({ projectIdOrName: projectId, flagIdOrSlug: flagId, ...scope })
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

const onOff: Vercel.FlagVariant[] = [
  { id: "on", value: true },
  { id: "off", value: false },
];

test.provider(
  "create, no-op redeploy, update, and destroy a boolean flag",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_LIFECYCLE, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.FeatureFlag("Flag", {
              project: projectId,
              kind: "boolean",
              variants: onOff,
              description: "initial",
              environments: {
                production: {
                  fallthrough: { type: "variant", variantId: "on" },
                },
              },
            });
          }),
        );
        expect(created.flagId).toMatch(/^flg_/);
        expect(created.projectId).toEqual(projectId);
        expect(created.kind).toEqual("boolean");
        expect(created.state).toEqual("active");
        expect(created.revision).toEqual(0);
        // Auto-generated slug is lowercase (flag slugs allow [a-zA-Z0-9_-]).
        expect(created.slug).toEqual(created.slug.toLowerCase());

        // Out-of-band verification via distilled.
        const observed = yield* featureFlags.getFlag({
          projectIdOrName: projectId,
          flagIdOrSlug: created.flagId,
          ...scope,
        });
        expect(observed.slug).toEqual(created.slug);
        expect(observed.description).toEqual("initial");
        expect(observed.environments.production?.active).toEqual(true);

        // No-op redeploy: same props — no spurious PATCH (revision pinned).
        const second = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.FeatureFlag("Flag", {
              project: projectId,
              kind: "boolean",
              variants: onOff,
              description: "initial",
              environments: {
                production: {
                  fallthrough: { type: "variant", variantId: "on" },
                },
              },
            });
          }),
        );
        expect(second.flagId).toEqual(created.flagId);
        expect(second.revision).toEqual(0);

        // Update in place: description + pause production.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.FeatureFlag("Flag", {
              project: projectId,
              kind: "boolean",
              variants: onOff,
              description: "updated",
              environments: {
                production: {
                  active: false,
                  pausedOutcome: { type: "variant", variantId: "off" },
                  fallthrough: { type: "variant", variantId: "on" },
                },
              },
            });
          }),
        );
        expect(updated.flagId).toEqual(created.flagId);
        expect(updated.revision).toBeGreaterThan(0);

        const observedUpdated = yield* featureFlags.getFlag({
          projectIdOrName: projectId,
          flagIdOrSlug: created.flagId,
          ...scope,
        });
        expect(observedUpdated.description).toEqual("updated");
        expect(observedUpdated.environments.production?.active).toEqual(false);
        expect(observedUpdated.environments.production?.pausedOutcome).toEqual({
          type: "variant",
          variantId: "off",
        });

        yield* stack.destroy();
        yield* expectFlagGone(projectId, created.flagId, scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_LIFECYCLE, scope)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "explicit slug: created verbatim, slug change replaces the flag",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;
      const projectId = yield* ensureHostProject(HOST_SLUG, scope);
      yield* Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.FeatureFlag("Flag", {
              project: projectId,
              slug: "alchemy-test-flag",
              kind: "string",
              variants: [
                { id: "a", value: "alpha" },
                { id: "b", value: "beta" },
              ],
              environments: {
                production: {
                  fallthrough: { type: "variant", variantId: "a" },
                },
              },
            });
          }),
        );
        expect(created.slug).toEqual("alchemy-test-flag");
        expect(created.kind).toEqual("string");

        // Changing the slug is a REPLACEMENT: new flag id, old slug gone.
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Vercel.FeatureFlag("Flag", {
              project: projectId,
              slug: "alchemy-test-flag-renamed",
              kind: "string",
              variants: [
                { id: "a", value: "alpha" },
                { id: "b", value: "beta" },
              ],
              environments: {
                production: {
                  fallthrough: { type: "variant", variantId: "a" },
                },
              },
            });
          }),
        );
        expect(replaced.slug).toEqual("alchemy-test-flag-renamed");
        expect(replaced.flagId).not.toEqual(created.flagId);
        yield* expectFlagGone(projectId, created.flagId, scope);

        yield* stack.destroy();
        yield* expectFlagGone(projectId, replaced.flagId, scope);
      }).pipe(Effect.ensuring(deleteHostProject(HOST_SLUG, scope)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);
