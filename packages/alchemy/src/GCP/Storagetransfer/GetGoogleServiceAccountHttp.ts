import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetGoogleServiceAccount } from "./GetGoogleServiceAccount.ts";
import type { TransferJob } from "./TransferJob.ts";

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
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* storagetransfer.getGoogleServiceAccounts.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (job: TransferJob) {
      const project = yield* job.project;
      return Effect.fn(
        `GCP.Storagetransfer.GetGoogleServiceAccount(${job.LogicalId})`,
      )(function* () {
        return yield* run({ projectId: yield* project });
      });
    });
  }),
);
