import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as teams from "@distilled.cloud/vercel/teams";
import * as user from "@distilled.cloud/vercel/user";
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

// HARD SAFETY RULE: inviting a member sends a REAL email invitation. Tests
// never invite external addresses — the ungated suites are read-only plus a
// probe whose email is unambiguously invalid (fails server-side validation
// before any invitation exists). The full lifecycle runs only with
// VERCEL_TEST_TEAM_INVITE=1 and an explicitly-provided address you control.
const INVITE_ENTITLED = !!process.env.VERCEL_TEST_TEAM_INVITE;
const INVITE_EMAIL = process.env.VERCEL_TEST_TEAM_INVITE_EMAIL;

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

// Read-only: the provider's list enumerates the standing team's members.
test.provider("list enumerates the standing team's members", () =>
  Effect.gen(function* () {
    const teamId = yield* resolveTeamId;
    const provider = yield* Provider.findProvider(Vercel.TeamMember);
    const members = yield* provider.list();
    expect(members.length).toBeGreaterThanOrEqual(1);
    for (const member of members) {
      expect(member.uid).toBeDefined();
      expect(member.email).toContain("@");
      expect(member.role).toBeDefined();
      expect(member.teamId).toEqual(teamId);
    }
  }).pipe(logLevel),
);

// Ungated probe: pins that the (patched, object-body) invite endpoint is
// wired correctly — an invalid email reaches server-side validation and is
// rejected with a TYPED BadRequest, and no invitation is ever created.
test.provider(
  "invite with an invalid email is rejected with typed BadRequest",
  () =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId;
      const invited = yield* Effect.result(
        teams.inviteUserToTeam({
          teamId,
          email: "not-an-email",
          role: "MEMBER",
        }),
      );
      expect(Result.isFailure(invited)).toBe(true);
      if (Result.isFailure(invited)) {
        expect(invited.failure._tag).toBe("BadRequest");
        if (invited.failure._tag === "BadRequest") {
          // `invalid_email` — proof the object body reached validation
          // (the unpatched array body dies earlier with "Expected an
          // object").
          expect(invited.failure.message).toContain("email");
        }
      }
    }).pipe(logLevel),
);

// Gated: full invite→role-update→remove lifecycle against an address the
// operator controls.
test.provider.skipIf(!INVITE_ENTITLED || !INVITE_EMAIL)(
  "invite, update role, and remove a member (VERCEL_TEST_TEAM_INVITE=1)",
  (stack) =>
    Effect.gen(function* () {
      const teamId = yield* resolveTeamId;
      const email = INVITE_EMAIL!;

      yield* stack.destroy();

      const member = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.TeamMember("Member", {
            email,
            role: "MEMBER",
          });
        }),
      );
      expect(member.email.toLowerCase()).toEqual(email.toLowerCase());
      expect(member.role).toEqual("MEMBER");
      expect(member.teamId).toEqual(teamId);

      // Role update in place — same uid.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.TeamMember("Member", {
            email,
            role: "DEVELOPER",
          });
        }),
      );
      expect(updated.uid).toEqual(member.uid);
      expect(updated.role).toEqual("DEVELOPER");

      yield* stack.destroy();

      // Typed wait-until-gone via the members feed.
      const stillThere = yield* teams
        .getTeamMembers({ teamId, limit: 100, search: email })
        .pipe(
          Effect.map((page) =>
            page.members.some(
              (m) => m.email.toLowerCase() === email.toLowerCase(),
            ),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (exists) => !exists,
            times: 10,
          }),
        );
      expect(stillThere).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
