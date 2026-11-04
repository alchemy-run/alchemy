import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
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
 * Grants the host `roles/storagetransfer.viewer` on the project because
 * Storage Transfer has no resource-level IAM.
 *
 * ### Looking up the Transfer Service Account
 * **Example:** Read the project service account
 * ```typescript
 * const getAccount = yield* GCP.StorageTransfer.GetGoogleServiceAccount(
 *   nightly,
 * );
 * const account = yield* getAccount();
 * ```
 *
 * @binding
 * @category StorageTransfer
 */
export interface GetGoogleServiceAccount extends Binding.Service<
  GetGoogleServiceAccount,
  "GCP.StorageTransfer.GetGoogleServiceAccount",
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
  "GCP.StorageTransfer.GetGoogleServiceAccount",
);

/**
 * HTTP implementation of {@link GetGoogleServiceAccount}.
 *
 * @layer
 * @provides GCP.StorageTransfer.GetGoogleServiceAccount
 */
export const GetGoogleServiceAccountHttp: Layer.Layer<
  GetGoogleServiceAccount,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetGoogleServiceAccount,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(storagetransfer.getGoogleServiceAccounts);
    return Effect.fn(function* (job: TransferJob) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.StorageTransfer.GetGoogleServiceAccount(${job})`({
          iam: [{ role: "roles/storagetransfer.viewer" }],
        });
      }
      const project = yield* job.project;
      return Effect.fn(`GCP.StorageTransfer.GetGoogleServiceAccount(${job.LogicalId})`)(
        function* () {
          return yield* run({ projectId: yield* project });
        },
      );
    });
  }),
);
