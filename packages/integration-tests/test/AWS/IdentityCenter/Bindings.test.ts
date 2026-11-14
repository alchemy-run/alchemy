import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import IdentityCenterBindingsFunctionLive, { IdentityCenterBindingsFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

const unredact = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// The testing account is an organization management account with no enabled
// Identity Center instance, and `CreateInstance` there fails with a typed
// ValidationException ("Organization management account is not allowed to
// perform the operation."), so the Lambda E2E — which binds a live instance —
// is gated behind ALCHEMY_TEST_IDENTITY_CENTER=1 for entitled accounts (same
// gate as the resource lifecycle tests in this suite).
const RUN_LIVE = !!process.env.ALCHEMY_TEST_IDENTITY_CENTER;

describe.sequential(
  "User resource",
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
  () => {
    test.provider.skipIf(!RUN_LIVE)(
      "creates, updates, renames and deletes a user without replacing it in the same store",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const userName = `alchemy-person-${stack.stage}@example.com`;
          const person = (props: Partial<AWS.IdentityCenter.UserProps> = {}) =>
            AWS.IdentityCenter.User("Person", {
              userName,
              displayName: "Alice Example",
              name: { givenName: "Alice", familyName: "Example", middleName: "Marie" },
              emails: [{ value: userName, type: "work", primary: true }],
              ...props,
            });

          const created = yield* stack.deploy(person());
          expect(created.userName).toBe(userName);
          const found = yield* identitystore.getUserId({
            IdentityStoreId: created.identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: { AttributePath: "userName", AttributeValue: userName },
            },
          });
          expect(found.UserId).toBe(created.userId);

          const renamed = `${userName}.renamed`;
          const desired = {
            userName: renamed,
            displayName: "Alice Updated",
            name: { givenName: "Alicia", familyName: "Example" },
            emails: undefined,
          };
          const updated = yield* stack.deploy(person(desired));
          expect(updated.userId).toBe(created.userId);
          const observed = yield* identitystore.describeUser({
            IdentityStoreId: created.identityStoreId,
            UserId: created.userId,
          });
          expect(unredact(observed.UserName)).toBe(renamed);
          expect(unredact(observed.DisplayName)).toBe("Alice Updated");
          expect(unredact(observed.Name?.GivenName)).toBe("Alicia");
          expect(unredact(observed.Name?.MiddleName)).toBe("Marie");
          expect(observed.Emails ?? []).toEqual([]);

          // Explicitly pinning, spelling as an ARN, or dropping a selector
          // must not replace the user and then delete the same physical ID.
          for (const identityStoreId of [
            created.identityStoreId,
            `arn:aws:identitystore::000000000000:identitystore/${created.identityStoreId}`,
            undefined,
          ]) {
            const pinned = person({ ...desired, identityStoreId });
            const plan = yield* stack.plan(pinned);
            expect(plan.resources.Person?.action).toBe("update");
            const user = yield* stack.deploy(pinned);
            expect(user.userId).toBe(created.userId);
            expect(user.identityStoreId).toBe(created.identityStoreId);
            yield* identitystore.describeUser({
              IdentityStoreId: created.identityStoreId,
              UserId: created.userId,
            });
          }

          // A new dependency's store is unresolved while planning, even
          // though it resolves to the same physical store on deployment.
          const fromDependency = Effect.gen(function* () {
            const group = yield* AWS.IdentityCenter.Group("StoreSelector", {
              displayName: `alchemy-store-selector-${stack.stage}`,
            });
            return yield* AWS.IdentityCenter.User("Person", {
              ...desired,
              identityStoreId: group.identityStoreId,
            });
          });
          const unresolved = yield* stack.plan(fromDependency);
          expect(unresolved.resources.Person?.action).toBe("update");
          const selected = yield* stack.deploy(fromDependency);
          expect(selected.userId).toBe(created.userId);
          yield* identitystore.describeUser({
            IdentityStoreId: created.identityStoreId,
            UserId: created.userId,
          });
          const redeployed = yield* stack.deploy(person(desired));
          expect(redeployed.userId).toBe(created.userId);
          const unchanged = yield* stack.plan(person(desired));
          expect(unchanged.resources.Person?.action).toBe("noop");

          yield* stack.destroy();
          const missing = yield* identitystore
            .describeUser({ IdentityStoreId: created.identityStoreId, UserId: created.userId })
            .pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "ResourceNotFoundException" });
        }),
    );

    test.provider.skipIf(!RUN_LIVE)(
      "requires explicit adoption of an existing user and converges its attributes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const instances = yield* ssoAdmin.listInstances({});
          const identityStoreId = instances.Instances![0]!.IdentityStoreId!;
          const userName = `alchemy-adopt-person-${stack.stage}@example.com`;
          const foreign = yield* identitystore.createUser({
            IdentityStoreId: identityStoreId,
            UserName: userName,
            DisplayName: "Outside Alchemy",
            Name: { GivenName: "Old", FamilyName: "Person" },
          });
          const person = AWS.IdentityCenter.User("Person", {
            identityStoreId,
            userName,
            displayName: "Adopted Person",
            name: { givenName: "New", familyName: "Person" },
          });

          const refused = yield* stack.deploy(person).pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse" });
          const preserved = yield* identitystore.describeUser({
            IdentityStoreId: identityStoreId,
            UserId: foreign.UserId,
          });
          expect(unredact(preserved.DisplayName)).toBe("Outside Alchemy");

          const adopted = yield* stack.deploy(person.pipe(adopt(true)));
          expect(adopted.userId).toBe(foreign.UserId);
          const observed = yield* identitystore.describeUser({
            IdentityStoreId: identityStoreId,
            UserId: foreign.UserId,
          });
          expect(unredact(observed.DisplayName)).toBe("Adopted Person");
          expect(unredact(observed.Name?.GivenName)).toBe("New");

          // A different user taking the owned user's name is not ours.
          yield* identitystore.deleteUser({
            IdentityStoreId: identityStoreId,
            UserId: adopted.userId,
          });
          const replacement = yield* identitystore.createUser({
            IdentityStoreId: identityStoreId,
            UserName: userName,
            DisplayName: "Another Person",
            Name: { GivenName: "Another", FamilyName: "Person" },
          });
          const changed = AWS.IdentityCenter.User("Person", {
            identityStoreId,
            userName,
            displayName: "Explicitly Adopted Again",
            name: { givenName: "New", familyName: "Person" },
          });
          const refusedReplacement = yield* stack.deploy(changed).pipe(Effect.flip);
          expect(refusedReplacement).toMatchObject({ _tag: "OwnedBySomeoneElse" });
          const untouched = yield* identitystore.describeUser({
            IdentityStoreId: identityStoreId,
            UserId: replacement.UserId,
          });
          expect(unredact(untouched.DisplayName)).toBe("Another Person");
          const adoptedAgain = yield* stack.deploy(changed.pipe(adopt(true)));
          expect(adoptedAgain.userId).toBe(replacement.UserId);

          // A missing owned user is recreated; cached output is not proof
          // that the old user still exists. Destroy tolerates absence too.
          yield* identitystore.deleteUser({
            IdentityStoreId: identityStoreId,
            UserId: adoptedAgain.userId,
          });
          const recreated = yield* stack.deploy(
            AWS.IdentityCenter.User("Person", {
              identityStoreId,
              userName,
              displayName: "Recreated Person",
              name: { givenName: "New", familyName: "Person" },
            }),
          );
          expect(recreated.userId).not.toBe(adoptedAgain.userId);
          yield* identitystore.deleteUser({
            IdentityStoreId: identityStoreId,
            UserId: recreated.userId,
          });
          yield* stack.destroy();
          const missing = yield* identitystore
            .getUserId({
              IdentityStoreId: identityStoreId,
              AlternateIdentifier: {
                UniqueAttribute: { AttributePath: "userName", AttributeValue: userName },
              },
            })
            .pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "ResourceNotFoundException" });
        }),
    );

    test.provider.skipIf(!RUN_LIVE)(
      "requires adoption when two new resources discover the same user",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const userName = `alchemy-shared-person-${stack.stage}@example.com`;
          const props = {
            userName,
            displayName: "First owner",
            name: { givenName: "Shared", familyName: "Person" },
          };
          const deployed = yield* stack
            .deploy(
              Effect.gen(function* () {
                const first = yield* AWS.IdentityCenter.User("First", props);
                const second = yield* AWS.IdentityCenter.User("Second", {
                  ...props,
                  displayName: "Other owner",
                });
                return { first, second };
              }),
            )
            .pipe(Effect.result);

          const instances = yield* ssoAdmin.listInstances({});
          const identityStoreId = instances.Instances![0]!.IdentityStoreId!;
          const found = yield* identitystore.getUserId({
            IdentityStoreId: identityStoreId,
            AlternateIdentifier: {
              UniqueAttribute: { AttributePath: "userName", AttributeValue: userName },
            },
          });
          const preserved = yield* identitystore.describeUser({
            IdentityStoreId: identityStoreId,
            UserId: found.UserId,
          });
          yield* stack.destroy();

          expect(Result.isFailure(deployed)).toBe(true);
          if (Result.isFailure(deployed)) {
            expect(deployed.failure).toMatchObject({ _tag: "OwnedBySomeoneElse" });
            if (deployed.failure._tag === "OwnedBySomeoneElse") {
              expect(["First", "Second"]).toContain(deployed.failure.logicalId);
              expect(unredact(preserved.DisplayName)).toBe(
                deployed.failure.logicalId === "First" ? "Other owner" : "First owner",
              );
            }
          }
        }),
    );

    test.provider.skipIf(!RUN_LIVE)(
      "updates dependents when a missing user is recreated",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const resources = (displayName: string) =>
            Effect.gen(function* () {
              const user = yield* AWS.IdentityCenter.User("Person", {
                userName: `alchemy-dependent-person-${stack.stage}@example.com`,
                displayName,
                name: { givenName: "Dependent", familyName: "Person" },
              });
              const group = yield* AWS.IdentityCenter.Group("Dependent", {
                displayName: user.userId,
              });
              return { user, group };
            });
          const created = yield* stack.deploy(resources("Before deletion"));
          yield* identitystore.deleteUser({
            IdentityStoreId: created.user.identityStoreId,
            UserId: created.user.userId,
          });
          const plan = yield* stack.plan(resources("After deletion"));
          const recreated = yield* stack.deploy(resources("After deletion"));
          const observed = yield* identitystore.describeGroup({
            IdentityStoreId: recreated.group.identityStoreId,
            GroupId: recreated.group.groupId,
          });
          yield* stack.destroy();

          yield* Effect.logInfo(
            JSON.stringify({
              dependentAction: plan.resources.Dependent?.action,
              previousUserId: created.user.userId,
              newUserId: recreated.user.userId,
              dependentDisplayName: unredact(observed.DisplayName),
            }),
          );
          expect(recreated.user.userId).not.toBe(created.user.userId);
          expect(unredact(observed.DisplayName)).toBe(recreated.user.userId);
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
