import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `CreateLanguageModel` request with `InputDataConfig.DataAccessRoleArn`
 * defaulting to the role the binding was constructed with.
 */
export interface CreateLanguageModelRequest extends Omit<
  transcribe.CreateLanguageModelRequest,
  "InputDataConfig"
> {
  /**
   * The Amazon S3 location of the training (and optional tuning) data.
   * `DataAccessRoleArn` defaults to the data-access role bound via
   * `CreateLanguageModel(role)`.
   */
  InputDataConfig: Omit<transcribe.InputDataConfig, "DataAccessRoleArn"> & {
    DataAccessRoleArn?: string;
  };
}

/**
 * Runtime binding for `transcribe:CreateLanguageModel` — kick off training of
 * a custom language model from text data in S3 (training runs asynchronously
 * and can take multiple hours; poll with {@link DescribeLanguageModel}).
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Transcribe assumes to read your S3 training data; its trust policy
 * must allow `transcribe.amazonaws.com`). The role's ARN is injected as
 * `InputDataConfig.DataAccessRoleArn` on every runtime request and the host
 * is granted `iam:PassRole` on it alongside `transcribe:CreateLanguageModel`
 * (which has no resource-level IAM).
 *
 * ### Custom Language Models
 * **Example:** Create a Custom Language Model
 * ```typescript
 * // init — bind the Transcribe data-access role
 * const createLanguageModel = yield* AWS.Transcribe.CreateLanguageModel(dataAccessRole);
 *
 * // runtime
 * yield* createLanguageModel({
 *   ModelName: "my-domain-model",
 *   BaseModelName: "NarrowBand",
 *   LanguageCode: "en-US",
 *   InputDataConfig: { S3Uri: "s3://my-bucket/training-data/" },
 * });
 * ```
 *
 * @binding
 */
export interface CreateLanguageModel extends Binding.Service<
  CreateLanguageModel,
  "AWS.Transcribe.CreateLanguageModel",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: CreateLanguageModelRequest,
    ) => Effect.Effect<transcribe.CreateLanguageModelResponse, transcribe.CreateLanguageModelError>
  >
> {}
export const CreateLanguageModel = Binding.Service<CreateLanguageModel>(
  "AWS.Transcribe.CreateLanguageModel",
);

// Bespoke (not makeTranscribeRoleHttpBinding): CreateLanguageModel nests the
// data-access role inside `InputDataConfig.DataAccessRoleArn` rather than as
// a top-level request field.
export const CreateLanguageModelHttp = Layer.effect(
  CreateLanguageModel,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const createLanguageModel = yield* AWSBindings.withCredentials(transcribe.createLanguageModel);

    return Effect.fn(function* <Rl extends Role>(dataAccessRole: Rl) {
      const RoleArn = yield* dataAccessRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Transcribe.CreateLanguageModel(${dataAccessRole})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["transcribe:CreateLanguageModel"],
              Resource: ["*"],
            },
            // CRITICAL: without iam:PassRole on the data-access role,
            // CreateLanguageModel fails only at runtime with an
            // AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [Output.interpolate`${dataAccessRole.roleArn}`],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "transcribe.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.Transcribe.CreateLanguageModel(${dataAccessRole.LogicalId})`)(
        function* (request: CreateLanguageModelRequest) {
          return yield* createLanguageModel({
            ...request,
            InputDataConfig: {
              ...request.InputDataConfig,
              DataAccessRoleArn: request.InputDataConfig.DataAccessRoleArn ?? (yield* RoleArn),
            },
          });
        },
      );
    });
  }),
);
