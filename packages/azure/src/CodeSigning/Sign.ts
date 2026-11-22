import type * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";
import type { CertificateProfile } from "./CertificateProfile.ts";

/** `SignCertificateProfileOperation` request without the endpoint, account and profile, which the binding supplies. */
export interface SignRequest extends Omit<
  sign.SignCertificateProfileOperationRequest,
  "endpoint" | "accountName" | "certificateProfile"
> {}

/**
 * Ask Artifact Signing to sign a digest with the certificate profile's key.
 * The service signs asynchronously: the result carries the
 * `operationLocation` to poll with `GetSigningStatus`.
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
 * Provide {@link SignHttp}.
 *
 * ### Calling Sign
 * **Example:** Sign from a Function
 * ```typescript
 * // init
 * const sign = yield* Azure.CodeSigning.Sign(account, profile);
 *
 * // runtime
 * const result = yield* sign({ signatureAlgorithm: "RS256", digest: sha256Base64 });
 * ```
 *
 * @binding
 * @category CodeSigning
 */
export interface Sign extends Binding.Service<
  Sign,
  "Azure.CodeSigning.Sign",
  (
    account: Account | string,
    profile: CertificateProfile,
  ) => Effect.Effect<
    (
      request: SignRequest,
    ) => Effect.Effect<
      sign.SignCertificateProfileOperationResponse,
      sign.SignCertificateProfileOperationError,
      RuntimeContext
    >
  >
> {}

export const Sign = Binding.Service<Sign>("Azure.CodeSigning.Sign");
