import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type IamMemberAttrs,
  type IamMemberProps,
  serviceAccountIamMemberProvider,
} from "./IamMember.ts";

export type ServiceAccountIamMemberProps = IamMemberProps & {
  /** Full service-account name or service-account email address. */
  serviceAccount: string;
};

export type ServiceAccountIamMember = Resource<
  "GCP.IAM.ServiceAccountIamMember",
  ServiceAccountIamMemberProps,
  IamMemberAttrs,
  never,
  Providers
>;

/**
 * Adds one principal to one role on a service account, such as a GKE
 * Workload Identity grant.
 *
 * ### Granting Workload Identity
 * **Example:** Let a Kubernetes service account use a Google service account
 * ```typescript
 * yield* GCP.IAM.ServiceAccountIamMember("RunnerIdentity", {
 *   serviceAccount: account.name,
 *   role: "roles/iam.workloadIdentityUser",
 *   member: "serviceAccount:my-project.svc.id.goog[vigla/runner]",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category IAM
 */
export const ServiceAccountIamMember = Resource<ServiceAccountIamMember>(
  "GCP.IAM.ServiceAccountIamMember",
);

export const ServiceAccountIamMemberProvider = () =>
  serviceAccountIamMemberProvider(ServiceAccountIamMember);
