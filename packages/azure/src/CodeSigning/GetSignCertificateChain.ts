import type * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";
import type { CertificateProfile } from "./CertificateProfile.ts";

/**
 * Download the certificate chain of the profile's signing certificates.
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
 * Provide {@link GetSignCertificateChainHttp}.
 *
 * ### Calling GetSignCertificateChain
 * **Example:** GetSignCertificateChain from a Function
 * ```typescript
 * // init
 * const getSignCertificateChain = yield* Azure.CodeSigning.GetSignCertificateChain(account, profile);
 *
 * // runtime
 * const result = yield* getSignCertificateChain();
 * ```
 *
 * @binding
 * @category CodeSigning
 */
export interface GetSignCertificateChain extends Binding.Service<
  GetSignCertificateChain,
  "Azure.CodeSigning.GetSignCertificateChain",
  (
    account: Account | string,
    profile: CertificateProfile,
  ) => Effect.Effect<
    () => Effect.Effect<
      sign.CertificateProfileOperationsGetSignCertificateChainResponse,
      sign.CertificateProfileOperationsGetSignCertificateChainError,
      RuntimeContext
    >
  >
> {}

export const GetSignCertificateChain = Binding.Service<GetSignCertificateChain>(
  "Azure.CodeSigning.GetSignCertificateChain",
);
