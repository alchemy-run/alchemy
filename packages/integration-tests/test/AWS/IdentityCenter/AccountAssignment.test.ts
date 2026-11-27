import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { AccountAssignment, Group, PermissionSet } from "@alchemy.run/aws/IdentityCenter";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Identity Center requires an enabled SSO instance / identity store in the
// testing account. If unavailable, `resolveInstance` fails with:
//   Error: "Unable to resolve a single visible Identity Center instance; pass instanceArn explicitly"
// The testing account is an organization management account where
// `CreateInstance` fails with a typed ValidationException ("Organization
// management account is not allowed to perform the operation."), so an
// instance cannot be provisioned programmatically. Gate the live list test
// behind ALCHEMY_TEST_IDENTITY_CENTER=1 so an entitled account runs it
// unchanged.
const SKIP_IDENTITY_CENTER = !process.env.ALCHEMY_TEST_IDENTITY_CENTER;

for (const { target, removeOld } of [
  { target: "principal", removeOld: false },
  { target: "permission set", removeOld: false },
  { target: "principal", removeOld: true },
  { target: "same principal", removeOld: false },
] as const) {
  test.provider.skipIf(SKIP_IDENTITY_CENTER)(
    `converges an unresolved ${target}${removeOld ? " after out-of-band deletion" : ""}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { accountId } = yield* AWSEnvironment.current;
        const resources = (second: boolean, previousPrincipalId?: string) =>
          Effect.gen(function* () {
            const firstSet = yield* PermissionSet("FirstSet", {
              name: "alchemy-retarget-first",
            });
            const first = yield* Group("First", { displayName: "alchemy-retarget-first" });
            const permissionSet =
              second && target === "permission set"
                ? yield* PermissionSet("SecondSet", { name: "alchemy-retarget-second" })
                : firstSet;
            const secondGroup =
              second && target !== "permission set"
                ? yield* Group("Second", { displayName: "alchemy-retarget-second" })
                : first;
            const principalId =
              previousPrincipalId === undefined
                ? secondGroup.groupId
                : Output.map(secondGroup.groupId, () => previousPrincipalId);
            const assignment = yield* AccountAssignment("Assignment", {
              permissionSetArn: permissionSet.permissionSetArn,
              principalType: "GROUP",
              principalId,
              targetId: accountId,
            });
            const dependent = yield* Group("Dependent", {
              displayName: Output.interpolate`${assignment.principalId}:${assignment.permissionSetArn}`,
            });
            return {
              assignment,
              dependent,
              principalId,
              permissionSetArn: permissionSet.permissionSetArn,
            };
          });
        const { assignment: first } = yield* stack.deploy(resources(false));
        const noop = yield* stack.plan(resources(false));
        expect(noop.resources.Assignment?.action).toBe("noop");
        yield* stack.deploy(resources(false));
        const unchanged = yield* ssoAdmin.listAccountAssignments({
          InstanceArn: first.instanceArn,
          AccountId: accountId,
          PermissionSetArn: first.permissionSetArn,
        });
        expect(unchanged.AccountAssignments?.map((item) => item.PrincipalId)).toEqual([
          first.principalId,
        ]);

        if (removeOld) {
          const deleted = yield* ssoAdmin.deleteAccountAssignment({
            InstanceArn: first.instanceArn,
            PermissionSetArn: first.permissionSetArn,
            PrincipalType: first.principalType,
            PrincipalId: first.principalId,
            TargetId: first.targetId,
            TargetType: first.targetType,
          });
          const status = yield* ssoAdmin
            .describeAccountAssignmentDeletionStatus({
              InstanceArn: first.instanceArn,
              AccountAssignmentDeletionRequestId:
                deleted.AccountAssignmentDeletionStatus!.RequestId!,
            })
            .pipe(
              Effect.repeat({
                while: (response) =>
                  response.AccountAssignmentDeletionStatus?.Status === "IN_PROGRESS",
                schedule: Schedule.spaced("5 seconds"),
                times: 10,
              }),
            );
          expect(status.AccountAssignmentDeletionStatus?.Status).toBe("SUCCEEDED");
        }

        const {
          assignment: second,
          dependent,
          principalId,
          permissionSetArn,
        } = yield* stack.deploy(
          resources(true, target === "same principal" ? first.principalId : undefined),
        );
        expect(second.principalId).toBe(principalId);
        expect(second.permissionSetArn).toBe(permissionSetArn);
        const listed = yield* ssoAdmin.listAccountAssignments({
          InstanceArn: second.instanceArn,
          AccountId: accountId,
          PermissionSetArn: permissionSetArn,
        });
        expect(listed.AccountAssignments?.map((item) => item.PrincipalId)).toEqual([principalId]);
        if (target === "permission set") {
          const previous = yield* ssoAdmin.listAccountAssignments({
            InstanceArn: first.instanceArn,
            AccountId: accountId,
            PermissionSetArn: first.permissionSetArn,
          });
          expect(previous.AccountAssignments).toEqual([]);
        }
        const described = yield* identitystore.describeGroup({
          IdentityStoreId: dependent.identityStoreId,
          GroupId: dependent.groupId,
        });
        const displayName = described.DisplayName;
        expect(
          Redacted.isRedacted(displayName) ? Redacted.value(displayName) : displayName,
        ).toEqual(`${principalId}:${permissionSetArn}`);

        yield* stack.destroy();
      }),
    { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
  );
}

test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "destroy removes the assignment while its permission set and principal remain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* AWSEnvironment.current;
      const instances = yield* ssoAdmin.listInstances({});
      const instance = instances.Instances![0]!;
      const permissionSet = yield* ssoAdmin.createPermissionSet({
        InstanceArn: instance.InstanceArn!,
        Name: "alchemy-assignment-destroy",
      });
      const group = yield* identitystore.createGroup({
        IdentityStoreId: instance.IdentityStoreId!,
        DisplayName: "alchemy-assignment-destroy",
      });
      yield* Effect.gen(function* () {
        const assignment = yield* stack.deploy(
          AccountAssignment("Assignment", {
            instanceArn: instance.InstanceArn!,
            permissionSetArn: permissionSet.PermissionSet!.PermissionSetArn!,
            principalId: group.GroupId,
            principalType: "GROUP",
            targetId: accountId,
          }),
        );
        yield* stack.destroy();
        const listed = yield* ssoAdmin.listAccountAssignments({
          InstanceArn: assignment.instanceArn,
          AccountId: accountId,
          PermissionSetArn: assignment.permissionSetArn,
        });
        expect(listed.AccountAssignments).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* identitystore.deleteGroup({
              IdentityStoreId: instance.IdentityStoreId!,
              GroupId: group.GroupId,
            });
            yield* ssoAdmin.deletePermissionSet({
              InstanceArn: instance.InstanceArn!,
              PermissionSetArn: permissionSet.PermissionSet!.PermissionSetArn!,
            });
          }).pipe(Effect.orDie),
        ),
      );
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);

// Canonical `list()` test for an account assignment (a fan-out collection:
// instances -> permission sets -> accounts -> assignments). Deploy a real
// permission set + group + assignment targeting the current account, resolve
// the provider from context via the typed `findProvider`, call `list()`, and
// assert the deployed assignment appears in the exhaustively-paginated result.
test.provider.skipIf(SKIP_IDENTITY_CENTER)(
  "list enumerates the deployed account assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* AWSEnvironment.current;

      const assignment = yield* stack.deploy(
        Effect.gen(function* () {
          const permissionSet = yield* PermissionSet("ListPermissionSet", {
            name: "alchemy-list-test-permission-set",
            description: "Permission set used to verify list() enumeration",
            sessionDuration: "1 hour",
          });

          const group = yield* Group("ListGroup", {
            displayName: "alchemy-list-assignment-group",
            description: "Group used to verify assignment list() enumeration",
          });

          return yield* AccountAssignment("ListAssignment", {
            permissionSetArn: permissionSet.permissionSetArn,
            principalType: "GROUP",
            principalId: group.groupId,
            targetId: accountId,
          });
        }),
      );

      const provider = yield* Provider.findProvider(AccountAssignment);
      const all = yield* provider.list();

      expect(
        all.some(
          (a) =>
            a.permissionSetArn === assignment.permissionSetArn &&
            a.principalId === assignment.principalId &&
            a.targetId === assignment.targetId,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"], timeout: 300_000 },
);

// A `creating` row can persist without resolved Outputs (`targetId` from
// `account.accountId`). Distilled `ListAccountAssignments` then fails with
// `ParseError: Expected string at ["AccountId"]`. Guarded `read` must report
// not-found without calling AWS.
test.provider(
  "read returns undefined when creating-state lost targetId",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AccountAssignment);
      const result = yield* provider.read!({
        id: "AccountAssignment",
        fqn: "AccountAssignment",
        instanceId: "test-instance",
        olds: {
          permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-example/ps-example",
          principalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          principalType: "GROUP",
        } as AccountAssignment["Props"],
        output: undefined,
      });
      expect(result).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);
