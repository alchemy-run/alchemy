import type * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";
import type { CertificateProfile } from "./CertificateProfile.ts";

/** `GetCertificateProfileOperationSigningStatus` request without the endpoint, account and profile, which the binding supplies. */
export interface GetSigningStatusRequest extends Omit<
  sign.GetCertificateProfileOperationSigningStatusRequest,
  "endpoint" | "accountName" | "certificateProfile"
> {}

/**
 * Get the state of a signing operation; once it `Succeeded` the result
 * carries the signature and the signing certificate.
 *
 * Binding assigns a custom role (`AzureCodeSigningSignRole`, one per stack)
 * with exactly the data action `certificateProfiles/Sign/action`, on the
 * certificate profile only. The smallest built-in role, **Artifact Signing
 * Certificate Profile Signer**, also reads every Artifact Signing resource.
 * Calls go to the account's regional endpoint: pass the `Account`, or its
 * `accountUri` (e.g. `https://eus.codesigning.azure.net/`) for an account
 * managed outside the stack. On a host
 * with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSigningStatusHttp}.
 *
 * ### Calling GetSigningStatus
 * **Example:** GetSigningStatus from a Function
 * ```typescript
 * // init
 * const getSigningStatus = yield* Azure.CodeSigning.GetSigningStatus(account, profile);
 *
 * // runtime
 * const result = yield* getSigningStatus({ operationId });
 * ```
 *
 * @binding
 * @category CodeSigning
 */
export interface GetSigningStatus extends Binding.Service<
  GetSigningStatus,
  "Azure.CodeSigning.GetSigningStatus",
  (
    account: Account | string,
    profile: CertificateProfile,
  ) => Effect.Effect<
    (
      request: GetSigningStatusRequest,
    ) => Effect.Effect<
      sign.GetCertificateProfileOperationSigningStatusResponse,
      sign.GetCertificateProfileOperationSigningStatusError,
      RuntimeContext
    >
  >
> {}

export const GetSigningStatus = Binding.Service<GetSigningStatus>(
  "Azure.CodeSigning.GetSigningStatus",
);
