import * as IdentityCenter from "@/AWS/IdentityCenter";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

/** Deterministic names — identical on every run of the gated E2E. */
export const TEST_GROUP_DISPLAY_NAME = "alchemy-identity-center-bindings-group";
const TEST_USER_NAME = "alchemy-identity-center-bindings-user";

export class IdentityCenterBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "IdentityCenterBindingsFunction",
) {}

/**
 * Lambda fixture exercising every IdentityCenter runtime binding against the
 * account's (pre-enabled) Identity Center instance:
 *
 * - identity store data plane: user CRUD (`CreateUser` → `GetUserId` →
 *   `DescribeUser` → `UpdateUser` → `DeleteUser`), group membership
 *   management (`CreateGroupMembership` → `GetGroupMembershipId` →
 *   `DescribeGroupMembership` → `IsMemberInGroups` →
 *   `ListGroupMemberships` / `ListGroupMembershipsForMember` →
 *   `DeleteGroupMembership`), and lookups (`GetGroupId`, `ListUsers`,
 *   `ListGroups`).
 * - sso-admin audit reads: `ListPermissionSets`, `DescribePermissionSet`,
 *   `ListAccountAssignments`, `ListAccountAssignmentsForPrincipal`,
 *   `ListAccountsForProvisionedPermissionSet`.
 *
 * The user + membership lifecycle route is self-cleaning (creates and then
 * deletes its user/membership) and tolerates leftovers from a crashed run
 * via the typed `ConflictException` → id-lookup fallback, so the stack
 * always destroys cleanly.
 */
export default IdentityCenterBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // The org/account Identity Center instance is a pre-existing singleton;
    // adopt it. Deleting the stack is a no-op for `mode: "existing"`.
    const instance = yield* IdentityCenter.Instance("BindingsInstance", {
      mode: "existing",
    });
    const group = yield* IdentityCenter.Group("BindingsGroup", {
      identityStoreId: instance.identityStoreId,
      displayName: TEST_GROUP_DISPLAY_NAME,
      description: "Group used by the IdentityCenter bindings E2E test",
    });
    const permissionSet = yield* IdentityCenter.PermissionSet(
      "BindingsPermissionSet",
      {
        instanceArn: instance.instanceArn,
        name: "alchemy-bindings-test-ps",
        description: "Permission set used by the IdentityCenter bindings test",
        sessionDuration: "1 hour",
      },
    );
    // Reference the resources so the engine deploys them before the Lambda.
    void group;
    void permissionSet;

    // identity store data plane
    const createUser = yield* IdentityCenter.CreateUser(instance);
    const describeUser = yield* IdentityCenter.DescribeUser(instance);
    const updateUser = yield* IdentityCenter.UpdateUser(instance);
    const deleteUser = yield* IdentityCenter.DeleteUser(instance);
    const listUsers = yield* IdentityCenter.ListUsers(instance);
    const getUserId = yield* IdentityCenter.GetUserId(instance);
    const listGroups = yield* IdentityCenter.ListGroups(instance);
    const getGroupId = yield* IdentityCenter.GetGroupId(instance);
    const createGroupMembership =
      yield* IdentityCenter.CreateGroupMembership(instance);
    const describeGroupMembership =
      yield* IdentityCenter.DescribeGroupMembership(instance);
    const deleteGroupMembership =
      yield* IdentityCenter.DeleteGroupMembership(instance);
    const getGroupMembershipId =
      yield* IdentityCenter.GetGroupMembershipId(instance);
    const isMemberInGroups = yield* IdentityCenter.IsMemberInGroups(instance);
    const listGroupMemberships =
      yield* IdentityCenter.ListGroupMemberships(instance);
    const listGroupMembershipsForMember =
      yield* IdentityCenter.ListGroupMembershipsForMember(instance);

    // sso-admin audit reads
    const listPermissionSets =
      yield* IdentityCenter.ListPermissionSets(instance);
    const describePermissionSet =
      yield* IdentityCenter.DescribePermissionSet(instance);
    const listAccountAssignments =
      yield* IdentityCenter.ListAccountAssignments(instance);
    const listAccountAssignmentsForPrincipal =
      yield* IdentityCenter.ListAccountAssignmentsForPrincipal(instance);
    const listAccountsForProvisionedPermissionSet =
      yield* IdentityCenter.ListAccountsForProvisionedPermissionSet(instance);

    const bound = {
      createUser,
      describeUser,
      updateUser,
      deleteUser,
      listUsers,
      getUserId,
      listGroups,
      getGroupId,
      createGroupMembership,
      describeGroupMembership,
      deleteGroupMembership,
      getGroupMembershipId,
      isMemberInGroups,
      listGroupMemberships,
      listGroupMembershipsForMember,
      listPermissionSets,
      describePermissionSet,
      listAccountAssignments,
      listAccountAssignmentsForPrincipal,
      listAccountsForProvisionedPermissionSet,
    };

    /** Resolve the fixture group's id by display name (SCIM unique attr). */
    const resolveGroupId = Effect.gen(function* () {
      const response = yield* getGroupId({
        AlternateIdentifier: {
          UniqueAttribute: {
            AttributePath: "displayName",
            AttributeValue: TEST_GROUP_DISPLAY_NAME,
          },
        },
      });
      return response.GroupId;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/users") {
          const response = yield* listUsers({});
          return yield* HttpServerResponse.json({
            count: (response.Users ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/groups") {
          const response = yield* listGroups({});
          const groupId = yield* resolveGroupId;
          return yield* HttpServerResponse.json({
            count: (response.Groups ?? []).length,
            groupId,
          });
        }

        if (request.method === "GET" && pathname === "/permission-sets") {
          const response = yield* listPermissionSets({});
          return yield* HttpServerResponse.json({
            arns: response.PermissionSets ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/permission-set") {
          const arn = url.searchParams.get("arn")!;
          const response = yield* describePermissionSet({
            PermissionSetArn: arn,
          });
          return yield* HttpServerResponse.json({
            name: response.PermissionSet?.Name,
            sessionDuration: response.PermissionSet?.SessionDuration,
          });
        }

        if (request.method === "GET" && pathname === "/provisioned-accounts") {
          const arn = url.searchParams.get("arn")!;
          const response = yield* listAccountsForProvisionedPermissionSet({
            PermissionSetArn: arn,
          });
          return yield* HttpServerResponse.json({
            count: (response.AccountIds ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/assignments") {
          const response = yield* listAccountAssignments({
            AccountId: url.searchParams.get("accountId")!,
            PermissionSetArn: url.searchParams.get("arn")!,
          });
          return yield* HttpServerResponse.json({
            count: (response.AccountAssignments ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/assignments-for-principal"
        ) {
          const groupId = yield* resolveGroupId;
          const response = yield* listAccountAssignmentsForPrincipal({
            PrincipalId: groupId,
            PrincipalType: "GROUP",
          });
          return yield* HttpServerResponse.json({
            count: (response.AccountAssignments ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/user-lifecycle") {
          const groupId = yield* resolveGroupId;

          // Create (or re-adopt, via the typed ConflictException) the user.
          const userId = yield* createUser({
            UserName: TEST_USER_NAME,
            DisplayName: "Alchemy Bindings User",
            Name: { GivenName: "Alchemy", FamilyName: "Bindings" },
            Emails: [
              { Value: "bindings@example.com", Type: "work", Primary: true },
            ],
          }).pipe(
            Effect.map((response) => response.UserId),
            Effect.catchTag("ConflictException", () =>
              getUserId({
                AlternateIdentifier: {
                  UniqueAttribute: {
                    AttributePath: "userName",
                    AttributeValue: TEST_USER_NAME,
                  },
                },
              }).pipe(Effect.map((response) => response.UserId)),
            ),
          );

          const described = yield* describeUser({ UserId: userId });

          // SCIM-style camelCase attribute path, same as UpdateGroup.
          yield* updateUser({
            UserId: userId,
            Operations: [
              {
                AttributePath: "displayName",
                AttributeValue: "Alchemy Bindings User (updated)",
              },
            ],
          });

          const membershipId = yield* createGroupMembership({
            GroupId: groupId,
            MemberId: { UserId: userId },
          }).pipe(
            Effect.map((response) => response.MembershipId!),
            Effect.catchTag("ConflictException", () =>
              getGroupMembershipId({
                GroupId: groupId,
                MemberId: { UserId: userId },
              }).pipe(Effect.map((response) => response.MembershipId!)),
            ),
          );

          const membership = yield* describeGroupMembership({
            MembershipId: membershipId,
          });
          const membershipIdLookup = yield* getGroupMembershipId({
            GroupId: groupId,
            MemberId: { UserId: userId },
          });
          const inGroups = yield* isMemberInGroups({
            MemberId: { UserId: userId },
            GroupIds: [groupId],
          });
          const memberships = yield* listGroupMemberships({
            GroupId: groupId,
          });
          const membershipsForMember = yield* listGroupMembershipsForMember({
            MemberId: { UserId: userId },
          });

          // Clean up — idempotent via the typed not-found.
          yield* deleteGroupMembership({ MembershipId: membershipId }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* deleteUser({ UserId: userId }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          return yield* HttpServerResponse.json({
            created: typeof userId === "string" && userId.length > 0,
            described: described.UserId === userId,
            membershipId,
            membershipMatches: membership.MembershipId === membershipId,
            lookupMatches: membershipIdLookup.MembershipId === membershipId,
            isMember:
              (inGroups.Results ?? []).some(
                (result) => result.MembershipExists === true,
              ) === true,
            membershipCount: (memberships.GroupMemberships ?? []).length,
            memberMembershipCount: (membershipsForMember.GroupMemberships ?? [])
              .length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdentityCenter.CreateUserHttp,
        IdentityCenter.DescribeUserHttp,
        IdentityCenter.UpdateUserHttp,
        IdentityCenter.DeleteUserHttp,
        IdentityCenter.ListUsersHttp,
        IdentityCenter.GetUserIdHttp,
        IdentityCenter.ListGroupsHttp,
        IdentityCenter.GetGroupIdHttp,
        IdentityCenter.CreateGroupMembershipHttp,
        IdentityCenter.DescribeGroupMembershipHttp,
        IdentityCenter.DeleteGroupMembershipHttp,
        IdentityCenter.GetGroupMembershipIdHttp,
        IdentityCenter.IsMemberInGroupsHttp,
        IdentityCenter.ListGroupMembershipsHttp,
        IdentityCenter.ListGroupMembershipsForMemberHttp,
        IdentityCenter.ListPermissionSetsHttp,
        IdentityCenter.DescribePermissionSetHttp,
        IdentityCenter.ListAccountAssignmentsHttp,
        IdentityCenter.ListAccountAssignmentsForPrincipalHttp,
        IdentityCenter.ListAccountsForProvisionedPermissionSetHttp,
      ),
    ),
  ),
);
