import type * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";
import type { CertificateProfile } from "./CertificateProfile.ts";

/**
 * List the extended key usages (EKU OIDs) the profile's certificates allow,
 * across pages.
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
 * Provide {@link ListExtendedKeyUsagesHttp}.
 *
 * ### Calling ListExtendedKeyUsages
 * **Example:** ListExtendedKeyUsages from a Function
 * ```typescript
 * // init
 * const listExtendedKeyUsages = yield* Azure.CodeSigning.ListExtendedKeyUsages(account, profile);
 *
 * // runtime
 * const result = yield* listExtendedKeyUsages();
 * ```
 *
 * @binding
 * @category CodeSigning
 */
export interface ListExtendedKeyUsages extends Binding.Service<
  ListExtendedKeyUsages,
  "Azure.CodeSigning.ListExtendedKeyUsages",
  (
    account: Account | string,
    profile: CertificateProfile,
  ) => Effect.Effect<
    () => Effect.Effect<
      sign.ExtendedKeyUsage[],
      sign.ListCertificateProfileOperationExtendedKeyUsagesError,
      RuntimeContext
    >
  >
> {}

export const ListExtendedKeyUsages = Binding.Service<ListExtendedKeyUsages>(
  "Azure.CodeSigning.ListExtendedKeyUsages",
);
