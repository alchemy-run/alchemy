import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as iam from "@distilled.cloud/cloudflare/iam";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic names — the same on every run (never Date.now()/random).
const GROUP_A_NAME = "alchemy-iam-ugm-group-a";
const GROUP_B_NAME = "alchemy-iam-ugm-group-b";

// The membership identity is an account-member id. Look one up from the
// account's member roster (the testing account always has at least its
// owner as an accepted member); pick deterministically.
const findMemberId = (accountId: string) =>
  accounts.listMembers.items({ accountId, status: "accepted" }).pipe(
    Stream.runCollect,
    Effect.flatMap((chunk) => {
      const ids = Array.from(chunk)
        .flatMap((m) => (m.id ? [m.id] : []))
        .sort();
      return ids.length > 0
        ? Effect.succeed(ids[0]!)
        : Effect.die(new Error("no accepted account members found"));
    }),
  );

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getMembership = (
  accountId: string,
  userGroupId: string,
  memberId: string,
) =>
  iam.getUserGroupMember({ accountId, userGroupId, memberId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A removed member answers GET with the typed `UserGroupMemberNotFound`;
// once the group itself is destroyed, with `UserGroupNotFound`. Both are
// the success condition here.
const expectGone = (accountId: string, userGroupId: string, memberId: string) =>
  getMembership(accountId, userGroupId, memberId).pipe(
    Effect.asSome,
    Effect.catchTag(
      ["UserGroupMemberNotFound", "UserGroupNotFound"],
      () => Effect.succeedNone,
    ),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (m) => m._tag === "None",
      times: 8,
    }),
    Effect.map((m) => expect(m._tag).toEqual("None")),
  );

// Both groups stay deployed across both steps; only the membership's target
// group flips, so the replacement is isolated to the membership itself.
const program = (opts: { memberId: string; target: "A" | "B" }) =>
  Effect.gen(function* () {
    const groupA = yield* Cloudflare.IamUserGroup("GroupA", {
      name: GROUP_A_NAME,
    });
    const groupB = yield* Cloudflare.IamUserGroup("GroupB", {
      name: GROUP_B_NAME,
    });
    const membership = yield* Cloudflare.IamUserGroupMembership("Membership", {
      userGroup: opts.target === "A" ? groupA.userGroupId : groupB.userGroupId,
      memberId: opts.memberId,
    });
    return { groupA, groupB, membership };
  });

test.provider(
  "create, verify out-of-band, replace when the user group changes, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const memberId = yield* findMemberId(accountId);

      yield* stack.destroy();

      // Create — member joins group A.
      const v1 = yield* stack.deploy(program({ memberId, target: "A" }));

      expect(v1.membership.userGroupId).toEqual(v1.groupA.userGroupId);
      expect(v1.membership.memberId).toEqual(memberId);
      expect(v1.membership.accountId).toEqual(accountId);

      // Out-of-band verification via the distilled API.
      const live = yield* getMembership(
        accountId,
        v1.groupA.userGroupId,
        memberId,
      );
      expect(live.id).toEqual(memberId);

      // Changing the target group is an identity change — the membership is
      // replaced: added to group B, removed from group A.
      const v2 = yield* stack.deploy(program({ memberId, target: "B" }));

      expect(v2.groupA.userGroupId).toEqual(v1.groupA.userGroupId);
      expect(v2.groupB.userGroupId).toEqual(v1.groupB.userGroupId);
      expect(v2.membership.userGroupId).toEqual(v2.groupB.userGroupId);
      expect(v2.membership.memberId).toEqual(memberId);

      const moved = yield* getMembership(
        accountId,
        v2.groupB.userGroupId,
        memberId,
      );
      expect(moved.id).toEqual(memberId);

      // The old membership in group A was deleted by the replacement.
      yield* expectGone(accountId, v1.groupA.userGroupId, memberId);

      yield* stack.destroy();

      // Destroy removed the membership (and the groups themselves).
      yield* expectGone(accountId, v2.groupB.userGroupId, memberId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
