import { ConfigError } from "@distilled.cloud/core/errors";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Effect from "effect/Effect";
import { requireOrganizationId, type StackitEnvironmentShape } from "../../Environment.ts";

/**
 * The STACKIT resource kinds the Membership API (authorization) manages
 * members and custom roles on.
 */
export type AuthorizationResourceType = "project" | "folder" | "organization";

/** The resource a membership or custom role is attached to. */
export interface AuthorizationScope {
  readonly resourceType: AuthorizationResourceType;
  readonly resourceId: string;
}

/**
 * Resolve the `resourceType` / `resourceId` props of an IAM resource:
 * `resourceType` defaults to `project`; `resourceId` defaults to the
 * environment's project for a project and to its organization for an
 * organization. A folder always needs an explicit `resourceId`.
 */
export const resolveScope = (
  props: { readonly resourceType?: AuthorizationResourceType; readonly resourceId?: string },
  env: StackitEnvironmentShape,
): Effect.Effect<AuthorizationScope, ConfigError> => {
  const resourceType = props.resourceType ?? "project";
  if (props.resourceId !== undefined && props.resourceId !== "") {
    return Effect.succeed({ resourceType, resourceId: props.resourceId });
  }
  if (resourceType === "project") {
    return Effect.succeed({ resourceType, resourceId: env.projectId });
  }
  if (resourceType === "organization") {
    return requireOrganizationId(env).pipe(
      Effect.map((resourceId) => ({ resourceType, resourceId })),
    );
  }
  return Effect.fail(
    ConfigError.make({
      message: `STACKIT IAM: \`resourceId\` is required when \`resourceType\` is "${resourceType}".`,
    }),
  );
};

export const sameScope = (a: AuthorizationScope, b: AuthorizationScope): boolean =>
  a.resourceType === b.resourceType && a.resourceId === b.resourceId;

/** Subjects are emails or client names; STACKIT compares them case-insensitively. */
export const sameSubject = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Observe whether `subject` holds `role` on the scope, through the
 * (subject-filtered) member list.
 */
export const hasMember = (scope: AuthorizationScope, subject: string, role: string) =>
  authorization
    .listMembers({ resourceType: scope.resourceType, resourceId: scope.resourceId, subject })
    .pipe(
      Effect.map((response) =>
        response.members.some(
          (member) => member.role === role && sameSubject(member.subject, subject),
        ),
      ),
    );

/**
 * Find a custom role on the scope: by id when known, otherwise by name.
 * Only roles with an id are custom roles; predefined roles are skipped.
 */
export const findCustomRole = (
  scope: AuthorizationScope,
  by: { readonly roleId?: string; readonly name?: string },
) =>
  authorization
    .listRoles({ resourceType: scope.resourceType, resourceId: scope.resourceId })
    .pipe(
      Effect.map((response) =>
        response.roles.find((role) =>
          role.id === undefined
            ? false
            : by.roleId !== undefined
              ? role.id === by.roleId
              : by.name !== undefined && role.name === by.name,
        ),
      ),
    );
