import type { Folder } from "../ResourceManager/Folder.ts";
import type { Organization } from "../ResourceManager/Organization.ts";
import type { Project } from "../ResourceManager/Project.ts";
import type { AuthorizationResourceType } from "./Membership.ts";

/**
 * What a Membership API binding reads: a {@link Project}, a {@link Folder}, an
 * {@link Organization}, or an explicit scope. Use the explicit scope for anything
 * this stack doesn't manage: any project-scoped resource's `projectId` attribute
 * names its project.
 */
export type AuthorizationTarget =
  | Project
  | Folder
  | Organization
  | {
      /** Kind of resource to read. */
      readonly resourceType: AuthorizationResourceType;
      /** Id of the project, folder or organization. */
      readonly resourceId: string;
    };
