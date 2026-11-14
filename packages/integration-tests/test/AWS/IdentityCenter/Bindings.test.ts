import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { adopt } from "alchemy/AdoptPolicy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import IdentityCenterBindingsFunctionLive, { IdentityCenterBindingsFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The testing account is an organization management account with no enabled
// Identity Center instance, and `CreateInstance` there fails with a typed
// ValidationException ("Organization management account is not allowed to
// perform the operation."), so the Lambda E2E — which binds a live instance —
// is gated behind ALCHEMY_TEST_IDENTITY_CENTER=1 for entitled accounts (same
// gate as the resource lifecycle tests in this suite).
const RUN_LIVE = !!process.env.ALCHEMY_TEST_IDENTITY_CENTER;

// Users are service fixtures, not the User resource from a sibling PR.
const directoryUsers = Effect.fn(function* (userName: string) {
  const instances = yield* ssoAdmin.listInstances({});
  const identityStoreId = instances.Instances![0]!.IdentityStoreId!;
  const users = yield* Effect.forEach([userName, `${userName}-second`], (userName) =>
    Effect.acquireRelease(
      identitystore.createUser({
        IdentityStoreId: identityStoreId,
        UserName: userName,
        DisplayName: userName,
        Name: { GivenName: "Membership", FamilyName: "Test" },
      }),
      (user) =>
        identitystore
          .deleteUser({
            IdentityStoreId: identityStoreId,
            UserId: user.UserId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.orDie,
          ),
    ),
  );
  return { identityStoreId, alice: users[0]!, bob: users[1]!, userName };
});

describe(
  "GroupMembership resource",
  { tags: ["live", "provider:aws", "provider:aws:identitycenter"] },
  () => {
    test.provider.skipIf(!RUN_LIVE)(
      "moves unresolved targets, preserves ID/ARN aliases and refreshes dependents",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { identityStoreId, alice, bob } = yield* directoryUsers("__proto__");
          const resources = (
            target: "first" | "second",
            member: "name" | "id" | "arn" | "bob",
            replaceGroup = false,
          ) =>
            Effect.gen(function* () {
              const first = yield* AWS.IdentityCenter.Group("First", {
                displayName: `membership-first-${stack.stage}`,
              });
              const second =
                target === "second"
                  ? yield* AWS.IdentityCenter.Group("Second", {
                      identityStoreId: replaceGroup ? identityStoreId : undefined,
                      displayName: `membership-second-${replaceGroup ? "new-" : ""}${stack.stage}`,
                    })
                  : undefined;
              const group = second ?? first;
              const membership = yield* AWS.IdentityCenter.GroupMembership("Member", {
                identityStoreId:
                  member === "arn"
                    ? `arn:aws:identitystore::000000000000:identitystore/${identityStoreId}`
                    : identityStoreId,
                groupId:
                  member === "arn"
                    ? group.groupId.pipe(
                        Output.map((id) => `arn:aws:identitystore::000000000000:group/${id}`),
                      )
                    : group.groupId,
                ...(member === "name"
                  ? { userName: "__proto__" }
                  : {
                      userId:
                        member === "bob"
                          ? bob.UserId
                          : member === "arn"
                            ? `arn:aws:identitystore::000000000000:user/${alice.UserId}`
                            : alice.UserId,
                    }),
              });
              const observer = yield* AWS.IdentityCenter.Group("Observer", {
                displayName: membership.membershipId,
              });
              return { membership, observer };
            });
          const initial = yield* stack.deploy(resources("first", "name"));
          const aliased = yield* stack.deploy(resources("first", "arn"));
          expect(aliased.membership.membershipId).toBe(initial.membership.membershipId);
          const described = yield* identitystore.describeGroupMembership({
            IdentityStoreId: identityStoreId,
            MembershipId: initial.membership.membershipId,
          });
          expect(described.MemberId?.UserId).toBe(alice.UserId);

          const plan = yield* stack.plan(resources("second", "id"));
          expect(plan.resources.Member?.action).toBe("update");
          expect(plan.resources.Observer?.action).toBe("update");
          const moved = yield* stack.deploy(resources("second", "id"));
          expect(moved.membership.groupId).not.toBe(initial.membership.groupId);
          expect(moved.membership.membershipId).not.toBe(initial.membership.membershipId);
          const missing = yield* Effect.flip(
            identitystore.describeGroupMembership({
              IdentityStoreId: identityStoreId,
              MembershipId: initial.membership.membershipId,
            }),
          );
          expect(missing).toMatchObject({ _tag: "ResourceNotFoundException" });

          const changedUser = yield* stack.deploy(resources("second", "bob"));
          expect(changedUser.membership.userId).toBe(bob.UserId);
          const oldUserMemberships = yield* identitystore.listGroupMembershipsForMember({
            IdentityStoreId: identityStoreId,
            MemberId: { UserId: alice.UserId },
          });
          expect(oldUserMemberships.GroupMemberships).toEqual([]);

          yield* identitystore.deleteGroupMembership({
            IdentityStoreId: identityStoreId,
            MembershipId: changedUser.membership.membershipId,
          });
          // Reconcile after external deletion and a change back to the first user.
          const recreated = yield* stack.deploy(resources("second", "arn"));
          expect(recreated.membership.membershipId).not.toBe(changedUser.membership.membershipId);
          const observed = yield* identitystore.describeGroup({
            IdentityStoreId: identityStoreId,
            GroupId: recreated.observer.groupId,
          });
          expect(
            Redacted.isRedacted(observed.DisplayName)
              ? Redacted.value(observed.DisplayName)
              : observed.DisplayName,
          ).toBe(recreated.membership.membershipId);
          const noop = yield* stack.plan(resources("second", "arn"));
          expect(noop.resources.Member?.action).toBe("noop");
          const replacementPlan = yield* stack.plan(resources("second", "arn", true));
          expect(replacementPlan.resources.Second?.action).toBe("replace");
          expect(replacementPlan.resources.Member?.action).toBe("update");
          expect(replacementPlan.resources.Observer?.action).toBe("update");
          const replaced = yield* stack.deploy(resources("second", "arn", true));
          expect(replaced.membership.groupId).not.toBe(recreated.membership.groupId);
          const replacementObserver = yield* identitystore.describeGroup({
            IdentityStoreId: identityStoreId,
            GroupId: replaced.observer.groupId,
          });
          expect(
            Redacted.isRedacted(replacementObserver.DisplayName)
              ? Redacted.value(replacementObserver.DisplayName)
              : replacementObserver.DisplayName,
          ).toBe(replaced.membership.membershipId);
          yield* identitystore.deleteGroupMembership({
            IdentityStoreId: identityStoreId,
            MembershipId: replaced.membership.membershipId,
          });
          yield* stack.destroy();
          yield* stack.destroy();
          expect(
            yield* Effect.flip(
              identitystore.describeGroupMembership({
                IdentityStoreId: identityStoreId,
                MembershipId: replaced.membership.membershipId,
              }),
            ),
          ).toMatchObject({ _tag: "ResourceNotFoundException" });
        }),
    );

    test.provider.skipIf(!RUN_LIVE)("refuses duplicate membership claims in one deploy", (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { identityStoreId, alice } = yield* directoryUsers(`duplicate-${stack.stage}`);
        const group = yield* stack.deploy(
          AWS.IdentityCenter.Group("Group", { displayName: `duplicate-membership-${stack.stage}` }),
        );
        const error = yield* Effect.flip(
          stack.deploy(
            Effect.gen(function* () {
              yield* AWS.IdentityCenter.Group("Group", {
                displayName: `duplicate-membership-${stack.stage}`,
              });
              const props = { identityStoreId, groupId: group.groupId, userId: alice.UserId };
              yield* AWS.IdentityCenter.GroupMembership("First", props);
              yield* AWS.IdentityCenter.GroupMembership("Second", props);
            }),
          ),
        );
        const members = yield* identitystore.listGroupMemberships({
          IdentityStoreId: identityStoreId,
          GroupId: group.groupId,
        });
        yield* stack.destroy();
        expect(error).toMatchObject({ _tag: "OwnedBySomeoneElse" });
        expect(members.GroupMemberships?.map((member) => member.MemberId?.UserId)).toEqual([
          alice.UserId,
        ]);
      }),
    );

    test.provider.skipIf(!RUN_LIVE)(
      "requires explicit adoption and preserves foreign membership on refusal",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { identityStoreId, alice, userName } = yield* directoryUsers(
            `adopt-${stack.stage}`,
          );
          const base = AWS.IdentityCenter.Group("Group", {
            displayName: `adopt-membership-${stack.stage}`,
          });
          const group = yield* stack.deploy(base);
          const foreign = yield* identitystore.createGroupMembership({
            IdentityStoreId: identityStoreId,
            GroupId: group.groupId,
            MemberId: { UserId: alice.UserId },
          });
          const resources = (enabled: boolean) =>
            Effect.gen(function* () {
              yield* base;
              return yield* AWS.IdentityCenter.GroupMembership("Member", {
                identityStoreId,
                groupId: group.groupId,
                userName,
              }).pipe(adopt(enabled));
            });
          const refused = yield* Effect.flip(stack.deploy(resources(false)));
          expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
          expect(
            (yield* identitystore.describeGroupMembership({
              IdentityStoreId: identityStoreId,
              MembershipId: foreign.MembershipId,
            })).MemberId?.UserId,
          ).toBe(alice.UserId);
          const adopted = yield* stack.deploy(resources(true));
          expect(adopted.membershipId).toBe(foreign.MembershipId);
          yield* stack.destroy();
          expect(
            yield* Effect.flip(
              identitystore.describeGroupMembership({
                IdentityStoreId: identityStoreId,
                MembershipId: foreign.MembershipId,
              }),
            ),
          ).toMatchObject({ _tag: "ResourceNotFoundException" });
        }),
    );
  },
);

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on are typed on every account, entitled or not, at near-zero cost.
test.provider(
  "describeUser on a nonexistent identity store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        identitystore.describeUser({
          IdentityStoreId: "d-9067000000",
          UserId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);

test.provider(
  "isMemberInGroups on a nonexistent identity store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        identitystore.isMemberInGroups({
          IdentityStoreId: "d-9067000000",
          MemberId: { UserId: "00000000-0000-0000-0000-000000000000" },
          GroupIds: ["00000000-0000-0000-0000-000000000000"],
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);

test.provider(
  "listPermissionSets on a nonexistent instance fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ssoAdmin.listPermissionSets({
          InstanceArn: "arn:aws:sso:::instance/ssoins-0000000000000000",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);

const sharedStack = Core.scratchStack(testOptions, "IdentityCenterBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(75)]);

let baseUrl: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const postJson = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe.sequential(
  "IdentityCenter Bindings (E2E)",
  { tags: ["provider:aws", "provider:aws:identitycenter", "provider:aws:lambda", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!RUN_LIVE) return;
        yield* Effect.logInfo("IdentityCenter E2E setup: destroying previous resources");
        yield* sharedStack.destroy();

        yield* Effect.logInfo("IdentityCenter E2E setup: deploying fixture");
        const attrs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* IdentityCenterBindingsFunction;
          }).pipe(Effect.provide(IdentityCenterBindingsFunctionLive)),
        );

        expect(attrs.functionUrl).toBeTruthy();
        baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

        yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(`Function not ready: ${response.status}`)),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      }),
      { timeout: 240_000 },
    );

    afterAll(
      Effect.gen(function* () {
        if (!RUN_LIVE) return;
        yield* sharedStack.destroy();
      }),
      { timeout: 180_000 },
    );

    describe("binding registration", () => {
      test.provider.skipIf(!RUN_LIVE)("all twenty capabilities initialize in the runtime", () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/bindings")) as { bound: string[] };
          expect(response.bound).toHaveLength(20);
        }),
      );
    });

    describe("group + user lookups", () => {
      test.provider.skipIf(!RUN_LIVE)(
        "listGroups sees the fixture group and getGroupId resolves it",
        () =>
          Effect.gen(function* () {
            const groups = (yield* getJson("/groups")) as { displayNames: string[] };
            expect(groups.displayNames).toContain("alchemy-idc-bindings-group");

            const groupId = (yield* getJson("/group-id")) as {
              groupId: string;
              matchesBoundGroup: boolean;
            };
            expect(groupId.matchesBoundGroup).toBe(true);
          }),
        { timeout: 120_000 },
      );

      test.provider.skipIf(!RUN_LIVE)(
        "listUsers enumerates the identity store",
        () =>
          Effect.gen(function* () {
            const users = (yield* getJson("/users")) as { userNames: string[] };
            expect(Array.isArray(users.userNames)).toBe(true);
          }),
        { timeout: 120_000 },
      );
    });

    describe("user lifecycle", () => {
      test.provider.skipIf(!RUN_LIVE)(
        "create/getUserId/describe/update/delete roundtrip",
        () =>
          Effect.gen(function* () {
            const result = (yield* postJson("/user-roundtrip")) as {
              userId: string;
              resolvedMatches: boolean;
              userName: string;
              displayNameBefore: string;
              displayNameAfter: string;
            };
            expect(result.userId).toBeTruthy();
            expect(result.resolvedMatches).toBe(true);
            expect(result.userName).toBe("alchemy-idc-bindings-user");
            expect(result.displayNameAfter).toBe("Alchemy Bindings Test User (updated)");
          }),
        { timeout: 120_000 },
      );
    });

    describe("membership lifecycle", () => {
      test.provider.skipIf(!RUN_LIVE)(
        "create/resolve/describe/list/check/delete roundtrip",
        () =>
          Effect.gen(function* () {
            const result = (yield* postJson("/membership-roundtrip")) as {
              membershipId: string;
              resolvedMatches: boolean;
              describedGroupMatches: boolean;
              memberCount: number;
              memberOfCount: number;
              isMember: boolean;
              isMemberAfterDelete: boolean;
            };
            expect(result.membershipId).toBeTruthy();
            expect(result.resolvedMatches).toBe(true);
            expect(result.describedGroupMatches).toBe(true);
            expect(result.memberCount).toBeGreaterThanOrEqual(1);
            expect(result.memberOfCount).toBeGreaterThanOrEqual(1);
            expect(result.isMember).toBe(true);
            expect(result.isMemberAfterDelete).toBe(false);
          }),
        { timeout: 120_000 },
      );
    });

    describe("permission set + assignment audit", () => {
      test.provider.skipIf(!RUN_LIVE)(
        "listPermissionSets/describePermissionSet see the fixture permission set",
        () =>
          Effect.gen(function* () {
            const result = (yield* getJson("/permission-sets")) as {
              containsFixturePermissionSet: boolean;
              name: string;
              sessionDuration: string;
              provisionedAccounts: string[];
            };
            expect(result.containsFixturePermissionSet).toBe(true);
            expect(result.name).toBe("AlchemyIdcBindings");
            expect(result.sessionDuration).toBe("PT1H");
          }),
        { timeout: 120_000 },
      );

      test.provider.skipIf(!RUN_LIVE)(
        "assignment audit reads answer for the fixture group",
        () =>
          Effect.gen(function* () {
            const result = (yield* getJson("/assignments")) as {
              forPrincipal: { ok: true; count: number } | { ok: false; errorTag: string };
            };
            // Organization instances answer with a count; account instances
            // reject ListAccountAssignmentsForPrincipal with a typed tag.
            if (result.forPrincipal.ok) {
              expect(result.forPrincipal.count).toBeGreaterThanOrEqual(0);
            } else {
              expect(result.forPrincipal.errorTag).toBeTruthy();
            }
          }),
        { timeout: 120_000 },
      );
    });
  },
);
