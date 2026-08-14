import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as accessGroups from "@distilled.cloud/vercel/access_groups";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Access Groups are an Enterprise-plan feature. On the standing (Pro) testing
// team every access-group op — including reads — answers 403. The ungated
// probe below pins that typed rejection; the full lifecycle runs only on an
// entitled account with VERCEL_TEST_ACCESS_GROUPS=1.
const ENTITLED = !!process.env.VERCEL_TEST_ACCESS_GROUPS;

// Deterministic names — same on every run.
const PROBE_NAME = "alchemy-access-group-probe";
const NAME_RENAMED = "alchemy-test-access-group-renamed";

const teamScopeOf = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

// Typed "is it gone?" wait — bounded, NotFound maps to gone.
const waitUntilAccessGroupGone = (
  idOrName: string,
  scope: { teamId?: string },
) =>
  accessGroups.readAccessGroup({ idOrName, ...scope }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => !exists,
      times: 10,
    }),
  );

// Ungated probe: proves the entitlement gate surfaces as the TYPED `Forbidden`
// tag (never a catch-all) on both a write and a read. Skipped on entitled
// accounts, where the gated lifecycle below runs instead.
test.provider.skipIf(ENTITLED)(
  "access groups are Enterprise-gated: typed Forbidden on create and read",
  () =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;

      const created = yield* Effect.result(
        accessGroups.createAccessGroup({ name: PROBE_NAME, ...scope }),
      );
      if (Result.isSuccess(created)) {
        // The account is actually entitled — clean up the probe group and
        // direct the runner to the gated lifecycle suite.
        yield* accessGroups
          .deleteAccessGroup({
            idOrName: created.success.accessGroupId,
            ...scope,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return yield* Effect.die(
          "createAccessGroup unexpectedly succeeded — this account is entitled; run with VERCEL_TEST_ACCESS_GROUPS=1",
        );
      }
      expect(created.failure._tag).toBe("Forbidden");
      if (created.failure._tag === "Forbidden") {
        expect(created.failure.message).toContain("permission");
      }

      const read = yield* Effect.result(
        accessGroups.readAccessGroup({
          idOrName: "ag_nonexistent0000000000000000",
          ...scope,
        }),
      );
      expect(Result.isFailure(read)).toBe(true);
      if (Result.isFailure(read)) {
        expect(read.failure._tag).toBe("Forbidden");
      }
    }).pipe(logLevel),
);

test.provider.skipIf(!ENTITLED)(
  "create, verify, rename, and destroy an access group",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;

      yield* stack.destroy();

      // Create with the engine-generated deterministic name and exact
      // (empty) managed membership.
      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.AccessGroup("Group", { members: [] });
        }),
      );
      expect(group.accessGroupId).toMatch(/^ag_/);
      expect(group.name).toBeDefined();
      expect(group.members).toEqual([]);

      // Out-of-band verification via distilled.
      const observed = yield* accessGroups.readAccessGroup({
        idOrName: group.accessGroupId,
        ...scope,
      });
      expect(observed.name).toEqual(group.name);
      expect(observed.teamId).toEqual(group.teamId);

      // Rename in place — same accessGroupId (update, not replace).
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.AccessGroup("Group", {
            name: NAME_RENAMED,
            members: [],
          });
        }),
      );
      expect(renamed.accessGroupId).toEqual(group.accessGroupId);
      expect(renamed.name).toEqual(NAME_RENAMED);

      const observedRenamed = yield* accessGroups.readAccessGroup({
        idOrName: group.accessGroupId,
        ...scope,
      });
      expect(observedRenamed.name).toEqual(NAME_RENAMED);

      yield* stack.destroy();
      const gone = yield* waitUntilAccessGroupGone(group.accessGroupId, scope);
      expect(gone).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ENTITLED)(
  "list enumerates the deployed access group",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* teamScopeOf;

      yield* stack.destroy();

      const group = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.AccessGroup("ListGroup", {});
        }),
      );

      const provider = yield* Provider.findProvider(Vercel.AccessGroup);
      const all = yield* provider.list();
      const found = all.find((g) => g.accessGroupId === group.accessGroupId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(group.name);

      yield* stack.destroy();
      const gone = yield* waitUntilAccessGroupGone(group.accessGroupId, scope);
      expect(gone).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
