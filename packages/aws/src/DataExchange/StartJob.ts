import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";

/**
 * Runtime binding for `dataexchange:StartJob`.
 *
 * Starts a created job. Jobs are created in the `WAITING` state and do
 * nothing until started. The job runs with the caller's forwarded
 * permissions, so this binding also grants `dataexchange:CreateAsset`
 * (import jobs) and `dataexchange:GetAsset` (export jobs); grant the S3
 * side of the transfer via the matching `AWS.S3` bindings.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.StartJobHttp)`.
 * ### Import & Export Jobs
 * **Example:** Start A Created Job
 * ```typescript
 * const startJob = yield* AWS.DataExchange.StartJob();
 *
 * // runtime
 * yield* startJob({ JobId: job.Id! });
 * ```
 *
 * @binding
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.DataExchange.StartJob",
  () => Effect.Effect<
    (
      request: dataexchange.StartJobRequest,
    ) => Effect.Effect<dataexchange.StartJobResponse, dataexchange.StartJobError>
  >
> {}
export const StartJob = Binding.Service<StartJob>("AWS.DataExchange.StartJob");

/**
 * Bespoke implementation (not the shared account builder): a started job
 * runs with the caller's forwarded permissions, so on top of the
 * `dataexchange:*` actions it needs S3 access to AWS Data Exchange's own
 * service buckets (`arn:aws:s3:::*aws-data-exchange*`) — import jobs write
 * staged assets there (`s3:PutObject`/`s3:PutObjectAcl`), export jobs read
 * them (`s3:GetObject`). Mirrors the AWS-managed
 * `AWSDataExchangeProviderFullAccess` policy, including the `aws:CalledVia`
 * condition that limits the S3 grant to calls made through Data Exchange.
 */
export const StartJobHttp = Layer.effect(
  StartJob,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(dataexchange.startJob);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.DataExchange.StartJob()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "dataexchange:StartJob",
                "dataexchange:CreateAsset",
                "dataexchange:GetAsset",
              ],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:PutObject", "s3:PutObjectAcl"],
              Resource: ["arn:aws:s3:::*aws-data-exchange*"],
              Condition: {
                "ForAnyValue:StringEquals": {
                  "aws:CalledVia": ["dataexchange.amazonaws.com"],
                },
              },
            },
          ],
        });
      }
      return Effect.fn("AWS.DataExchange.StartJob")(function* (
        request: dataexchange.StartJobRequest,
      ) {
        return yield* op(request);
      });
    });
  }),
);
