import * as Output from "alchemy/Output";
import { isResourceOfType, type ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Folder } from "../ResourceManager/Folder.ts";
import type { Organization } from "../ResourceManager/Organization.ts";
import type { Project } from "../ResourceManager/Project.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { AuthorizationTarget } from "./AuthorizationTarget.ts";
import type { CustomRole } from "./CustomRole.ts";
import type { AuthorizationResourceType } from "./Membership.ts";
import type { ServiceAccount } from "./ServiceAccount.ts";

/**
 * Shared HTTP scaffolding for IAM bindings.
 * NOT exported from index.ts.
 */

/** A target's scope. An explicit scope's id is usually an Output at bind time. */
interface BoundScope {
  readonly resourceType: AuthorizationResourceType;
  readonly resourceId: string | Output.Output<string, never>;
}

const isProject = (target: AuthorizationTarget): target is Project =>
  isResourceOfType(target, "Stackit.ResourceManager.Project");

const isFolder = (target: AuthorizationTarget): target is Folder =>
  isResourceOfType(target, "Stackit.ResourceManager.Folder");

const isOrganization = (target: AuthorizationTarget): target is Organization =>
  isResourceOfType(target, "Stackit.ResourceManager.Organization");

const scopeOf = (target: AuthorizationTarget): BoundScope => {
  if (isProject(target)) return { resourceType: "project", resourceId: target.projectId };
  if (isFolder(target)) return { resourceType: "folder", resourceId: target.folderId };
  if (isOrganization(target)) {
    return { resourceType: "organization", resourceId: target.organizationId };
  }
  return target;
};

/** The request fields of an operation taking `resourceType` and `resourceId`. */
export const byResourceId = (scope: { resourceType: string; resourceId: string }) => ({
  resourceType: scope.resourceType,
  resourceId: scope.resourceId,
});

/** The request fields of an operation naming the id `resource`. */
export const byResource = (scope: { resourceType: string; resourceId: string }) => ({
  resourceType: scope.resourceType,
  resource: scope.resourceId,
});

/**
 * A binding on a project, folder or organization, the kinds of resource STACKIT
 * binds roles on, so the grant is exactly the target. `makeHttpBinding` doesn't
 * fit because an explicit scope isn't a resource.
 */
export const makeAuthorizationHttpBinding = <I, A, E, K extends keyof I>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.IAM.ListMembers`. */
  tag: string;
  /** What the operation needs on the target. */
  access: StackitBindings.Access;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
  /** The request fields naming the target. */
  fields: (scope: { resourceType: string; resourceId: string }) => { readonly [P in K]: unknown };
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* (target: AuthorizationTarget) {
      const scope = scopeOf(target);
      const resourceId = Output.isOutput(scope.resourceId)
        ? yield* scope.resourceId
        : Effect.succeed(scope.resourceId);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${target})`({
          grants: [StackitBindings.grantOnScope(scope, options.access)],
        });
      }
      return Effect.fn(options.tag)(function* (request?: Omit<I, K>) {
        const fields = options.fields({
          resourceType: scope.resourceType,
          resourceId: yield* resourceId,
        });
        // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
        return yield* run({ ...request, ...fields } as unknown as I);
      });
    });
  });

/**
 * A binding with no target and no role: the operation answers any authenticated
 * caller, so the host only needs an identity.
 */
export const makeUnscopedHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.IAM.ListPermissions`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({ grants: [] });
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* run({ ...request } as unknown as I);
      });
    });
  });

/** Where a custom role is defined. An omitted id is the profile's, as on the role. */
const customRoleScope = (role: ResourceLike): StackitBindings.GrantScope => ({
  resourceType: (role.Props?.resourceType as AuthorizationResourceType | undefined) ?? "project",
  resourceId: role.Props?.resourceId,
});

/** A binding on a custom role, granted where the role is defined. */
export const makeCustomRoleHttpBinding = <
  I extends { resourceType: string; resourceId: string; roleId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.IAM.GetRole`. */
  tag: string;
  /** What the operation needs on the role's scope. */
  access: StackitBindings.Access;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (role: CustomRole) => ({
      resourceType: role.resourceType,
      resourceId: role.resourceId,
      roleId: role.roleId,
    }),
    grants: (role) => [StackitBindings.grantOnScope(customRoleScope(role), options.access)],
  });

/** A binding on a service account, granted on the project holding it. */
export const makeServiceAccountHttpBinding = <
  I extends { projectId: string; serviceAccountEmail: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.IAM.ListServiceAccountKeys`. */
  tag: string;
  /** What the operation needs on the account's project. */
  access: StackitBindings.Access;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (account: ServiceAccount) => ({
      projectId: account.projectId,
      serviceAccountEmail: account.email,
    }),
    grants: (account) => [StackitBindings.grantOn(account, options.access)],
  });

/** A binding on a service account's public data, which needs no role. */
export const makePublicServiceAccountHttpBinding = <
  I extends { serviceAccountEmail: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.IAM.GetJWKS`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (account: ServiceAccount) => ({ serviceAccountEmail: account.email }),
    grants: () => [],
  });
