import type * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { TransferJob } from "./TransferJob.ts";

/**
 * Runtime binding for Storage Transfer `googleServiceAccounts.get`.
 *
 * Returns the Google-managed service account Storage Transfer uses to
 * read source buckets and write sink buckets. Grant this identity
 * `roles/storage.objectViewer` (source) and `roles/storage.objectAdmin`
 * (sink). Bind this operation to a {@link TransferJob} in a
 * Function/Action init phase. Provide {@link GetGoogleServiceAccountHttp}.
 *
 * ### Looking up the Transfer Service Account
 * **Example:** Read the project service account
 * ```typescript
 * const getAccount = yield* GCP.Storagetransfer.GetGoogleServiceAccount(
 *   nightly,
 * );
 * const account = yield* getAccount();
 * ```
 *
 * @binding
 * @product GCP
 * @category Storagetransfer
 */
export interface GetGoogleServiceAccount extends Binding.Service<
  GetGoogleServiceAccount,
  "GCP.Storagetransfer.GetGoogleServiceAccount",
  (
    job: TransferJob,
  ) => Effect.Effect<
    () => Effect.Effect<
      storagetransfer.GoogleServiceAccount,
      storagetransfer.GetGoogleServiceAccountsError,
      RuntimeContext
    >
  >
> {}

export const GetGoogleServiceAccount = Binding.Service<GetGoogleServiceAccount>(
  "GCP.Storagetransfer.GetGoogleServiceAccount",
);
