import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetGoogleServiceAccount } from "./GetGoogleServiceAccount.ts";
import type { TransferJob } from "./TransferJob.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetGoogleServiceAccount}.
 *
 * @layer
 * @provides GCP.Storagetransfer.GetGoogleServiceAccount
 */
export const GetGoogleServiceAccountHttp: Layer.Layer<
  GetGoogleServiceAccount,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetGoogleServiceAccount,
  Effect.gen(function* () {
    const run = yield* storagetransfer.getGoogleServiceAccounts;
    return Effect.fn(function* (job: TransferJob) {
      yield* bindGcpHost({
        tag: "GCP.Storagetransfer.GetGoogleServiceAccount",
        resource: job,
        iam: [
          {
            role: defaultRoleFor("GCP.Storagetransfer.GetGoogleServiceAccount"),
          },
        ],
      });
      const project = yield* job.project;
      return Effect.fn(
        `GCP.Storagetransfer.GetGoogleServiceAccount(${job.LogicalId})`,
      )(function* () {
        return yield* run({ projectId: yield* project });
      });
    });
  }),
);
