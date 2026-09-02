import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type IamMemberAttrs,
  type IamMemberProps,
  projectIamMemberProvider,
} from "./IamMember.ts";

export type ProjectIamMemberProps = IamMemberProps & {
  /** Project id or `projects/{id}`. Defaults to the current project. */
  project?: string;
};

export type ProjectIamMember = Resource<
  "GCP.IAM.ProjectIamMember",
  ProjectIamMemberProps,
  IamMemberAttrs,
  never,
  Providers
>;

/**
 * Adds one principal to one role on a project without replacing its IAM
 * policy or disturbing unrelated bindings.
 *
 * ### Granting Project Access
 * **Example:** Let a service account pull Artifact Registry images
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("GkeNodes", {
 *   accountId: "prod-gke-nodes",
 * });
 * yield* GCP.IAM.ProjectIamMember("ArtifactReader", {
 *   role: "roles/artifactregistry.reader",
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category IAM
 */
export const ProjectIamMember = Resource<ProjectIamMember>(
  "GCP.IAM.ProjectIamMember",
);

export const ProjectIamMemberProvider = () =>
  projectIamMemberProvider(ProjectIamMember);
