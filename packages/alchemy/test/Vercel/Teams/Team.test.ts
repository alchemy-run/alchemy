import { adopt } from "@/AdoptPolicy";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as teams from "@distilled.cloud/vercel/teams";
import * as user from "@distilled.cloud/vercel/user";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// HARD SAFETY RULE: creating a Vercel team has BILLING side effects. Tests
// never create a team — the ungated suites only ADOPT the standing testing
// team and manage settings that are safely revertible. The creation
// lifecycle is implemented but runs only with VERCEL_TEST_TEAM_CREATE=1 on
// an account where a throwaway team is acceptable.
const CREATE_ENTITLED = !!process.env.VERCEL_TEST_TEAM_CREATE;

// Deterministic values — same on every run. The team's description ends
// every run on the standing value (the platform ignores empty-string
// updates and rejects null, so a description can never be cleared — manage
// it between two non-empty values instead).
const DESC_MANAGED = "alchemy testing team (managed by Vercel.Team test)";
const DESC_STANDING = "alchemy testing team";

const resolveTeamId = Effect.gen(function* () {
  const { teamId } = yield* Vercel.VercelEnvironment.current;
  if (teamId !== undefined) return teamId;
  const auth = yield* user.getAuthUser({});
  const defaultTeamId = auth.user.defaultTeamId;
  if (defaultTeamId === null || defaultTeamId === undefined) {
    return yield* Effect.die(
      "requires a team-scoped VERCEL_TOKEN or a user with a default team",
    );
  }
  return defaultTeamId;
});

// Ungated probe: pins that team creation is guarded by server-side slug
// validation with a TYPED BadRequest — and, critically, that the probe
// itself can never create a team (the slug is unambiguously invalid).
test.provider(
  "createTeam rejects an invalid slug with typed BadRequest (no team created)",
  () =>
    Effect.gen(function* () {
      const created = yield* Effect.result(
        teams.createTeam({ slug: "ALCHEMY INVALID SLUG !!" }),
      );
      expect(Result.isFailure(created)).toBe(true);
      if (Result.isFailure(created)) {
        // POST /v1/teams is capped at FIVE requests per 24h on this plan
        // (`api-teams-post-free`, 429 with retry-after: 86400) — once the
        // window is burned, the invalid-slug rejection is unobservable, so
        // the typed throttle is an equally valid probe outcome. Either way:
        // typed failure, no team created.
        expect(["BadRequest", "TooManyRequests"]).toContain(
          created.failure._tag,
        );
        if (created.failure._tag === "BadRequest") {
          expect(created.failure.message).toContain("slug");
        }
      }
    }).pipe(logLevel),
);

// The primary ungated lifecycle: adopt the standing team, manage a safely
// revertible setting, and verify destroy RELEASES the adopted team without
// deleting it.
test.provider(
  "adopts the standing team, manages settings, and releases without deleting",
  (stack) =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId;
      const before = yield* teams.getTeam({ teamId });

      yield* stack.destroy();

      // Adopt the existing team by slug and set the managed description.
      const team = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Team("Team", {
            slug: before.slug,
            description: DESC_MANAGED,
          }).pipe(adopt(true));
        }),
      );
      expect(team.teamId).toEqual(teamId);
      expect(team.slug).toEqual(before.slug);
      expect(team.created).toBe(false);
      expect(team.description).toEqual(DESC_MANAGED);

      // Out-of-band verification via distilled.
      const observed = yield* teams.getTeam({ teamId });
      expect(observed.description).toEqual(DESC_MANAGED);

      // Update in place — revert the description to the standing value.
      const reverted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Team("Team", {
            slug: before.slug,
            description: DESC_STANDING,
          }).pipe(adopt(true));
        }),
      );
      expect(reverted.teamId).toEqual(teamId);
      expect(reverted.description).toEqual(DESC_STANDING);

      // Destroy releases the adopted team — it must still exist untouched.
      yield* stack.destroy();
      const after = yield* teams.getTeam({ teamId });
      expect(after.id).toEqual(teamId);
      expect(after.slug).toEqual(before.slug);
      expect(after.description).toEqual(DESC_STANDING);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Idempotent redeploy: same props → no drift, same identity.
test.provider(
  "redeploy with unchanged settings is a stable no-op",
  (stack) =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId;
      const before = yield* teams.getTeam({ teamId });

      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Team("Team", {
            slug: before.slug,
            description: DESC_STANDING,
          }).pipe(adopt(true));
        }),
      );
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Team("Team", {
            slug: before.slug,
            description: DESC_STANDING,
          }).pipe(adopt(true));
        }),
      );
      expect(second.teamId).toEqual(first.teamId);
      expect(second.updatedAt).toBeDefined();
      expect(second.description).toEqual(DESC_STANDING);

      yield* stack.destroy();
      const after = yield* teams.getTeam({ teamId });
      expect(after.id).toEqual(teamId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Gated: the full create→update→delete lifecycle. Creating a team has
// billing side effects, so this only runs when explicitly requested.
test.provider.skipIf(!CREATE_ENTITLED)(
  "create, update, and destroy a team (VERCEL_TEST_TEAM_CREATE=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const team = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Team("CreatedTeam", {
            name: "alchemy created team",
          });
        }),
      );
      expect(team.teamId).toMatch(/^team_/);
      expect(team.created).toBe(true);

      const observed = yield* teams.getTeam({ teamId: team.teamId });
      expect(observed.slug).toEqual(team.slug);

      yield* stack.destroy();
      const gone = yield* Effect.result(teams.getTeam({ teamId: team.teamId }));
      expect(Result.isFailure(gone)).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
