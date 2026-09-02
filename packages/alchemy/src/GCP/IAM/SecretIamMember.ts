import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type IamMemberAttrs,
  type IamMemberProps,
  secretIamMemberProvider,
} from "./IamMember.ts";

export type SecretIamMemberProps = IamMemberProps & {
  /** Full Secret Manager secret resource name. */
  secret: string;
};

export type SecretIamMember = Resource<
  "GCP.IAM.SecretIamMember",
  SecretIamMemberProps,
  IamMemberAttrs,
  never,
  Providers
>;

/**
 * Adds one principal to one role on a Secret Manager secret.
 *
 * ### Granting Secret Access
 * **Example:** Let a service account read secret versions
 * ```typescript
 * yield* GCP.IAM.SecretIamMember("SecretReader", {
 *   secret: secret.name,
 *   role: "roles/secretmanager.secretAccessor",
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category IAM
 */
export const SecretIamMember = Resource<SecretIamMember>(
  "GCP.IAM.SecretIamMember",
);

export const SecretIamMemberProvider = () =>
  secretIamMemberProvider(SecretIamMember);
