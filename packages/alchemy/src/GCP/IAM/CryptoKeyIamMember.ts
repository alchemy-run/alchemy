import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  cryptoKeyIamMemberProvider,
  type IamMemberAttrs,
  type IamMemberProps,
} from "./IamMember.ts";

export type CryptoKeyIamMemberProps = IamMemberProps & {
  /** Full Cloud KMS CryptoKey resource name. */
  cryptoKey: string;
};

export type CryptoKeyIamMember = Resource<
  "GCP.IAM.CryptoKeyIamMember",
  CryptoKeyIamMemberProps,
  IamMemberAttrs,
  never,
  Providers
>;

/**
 * Adds one principal to one role on a Cloud KMS CryptoKey.
 *
 * ### Granting Key Access
 * **Example:** Let a service account decrypt with a key
 * ```typescript
 * yield* GCP.IAM.CryptoKeyIamMember("Decrypt", {
 *   cryptoKey: key.name,
 *   role: "roles/cloudkms.cryptoKeyDecrypter",
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category IAM
 */
export const CryptoKeyIamMember = Resource<CryptoKeyIamMember>(
  "GCP.IAM.CryptoKeyIamMember",
);

export const CryptoKeyIamMemberProvider = () =>
  cryptoKeyIamMemberProvider(CryptoKeyIamMember);
