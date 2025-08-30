import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type { Context } from "../../../context.ts";
import { Resource } from "../../../resource.ts";

import { IAM } from "itty-aws/iam";

/**
 * Properties for creating or updating an IAM policy
 */
export interface PolicyProps {
  /**
   * The name of the policy
   *
   * @default ${app}-${stage}-${id}
   *
   */
  name: string;

  /**
   * The path for the policy
   * @default "/"
   */
  path?: string;

  /**
   * The policy document as a JSON string
   */
  policy: string;

  /**
   * Description of the policy
   */
  description?: string;

  /**
   * Key-value mapping of resource tags
   */
  tags?: Record<string, string>;
}

/**
 * Output returned after IAM policy creation/update
 */
export interface Policy extends Resource<"AWS::IAM::Policy">, PolicyProps {
  /**
   * The Amazon Resource Name (ARN) of the policy
   */
  arn: string;

  /**
   * The unique identifier of the policy
   */
  policyId: string;
}

/**
 * AWS IAM Policy Resource
 *
 * Creates and manages IAM policies that define permissions for AWS services and resources.
 * Supports automatic versioning and updates when policy content changes.
 *
 * @example
 * ## Basic S3 Access Policy
 *
 * Create a policy that allows S3 bucket access with read and write permissions.
 *
 * ```ts
 * const s3Policy = await Policy("s3-access", {
 *   name: "s3-bucket-access",
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Action: [
 *         "s3:GetObject",
 *         "s3:PutObject"
 *       ],
 *       Resource: "arn:aws:s3:::my-bucket/*"
 *     }]
 *   }),
 *   description: "Allows read/write access to S3 bucket"
 * });
 * ```
 *
 * @example
 * ## Policy with Multiple Statements
 *
 * Create a comprehensive policy with multiple statements and conditions.
 *
 * ```ts
 * const apiPolicy = await Policy("api-access", {
 *   name: "api-gateway-access",
 *   policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Sid: "InvokeAPI",
 *         Effect: "Allow",
 *         Action: "execute-api:Invoke",
 *         Resource: "arn:aws:execute-api:*:*:*\/prod/*",
 *         Condition: {
 *           StringEquals: {
 *             "aws:SourceVpc": "vpc-12345"
 *           }
 *         }
 *       },
 *       {
 *         Sid: "ReadLogs",
 *         Effect: "Allow",
 *         Action: [
 *           "logs:GetLogEvents",
 *           "logs:FilterLogEvents"
 *         ],
 *         Resource: "arn:aws:logs:*:*:*"
 *       }
 *     ]
 *   }),
 *   description: "API Gateway access with logging permissions",
 *   tags: {
 *     Service: "API Gateway",
 *     Environment: "production"
 *   }
 * });
 * ```
 *
 */
export const Policy = Resource(
  "AWS::IAM::Policy",
  async function (
    this: Context<Policy>,
    _id: string,
    props: PolicyProps,
  ): Promise<Policy> {
    const iam = new IAM({});

    if (this.phase === "delete") {
      
    }

    Match.value(this.phase).pipe(
      Match.when("create", () => {
        console.log("do create");

        const policyArn = this.output?.arn;

        // if there's an existing ARN for this resource, we should do nothing on create
        if (!policyArn) {
          // no policy ARN in state means we haven't created it yet
          const createEffect = Effect.gen(function* () {
            const tags = props.tags
              ? Object.entries(props.tags).map(([Key, Value]) => ({
                  Key,
                  Value,
                }))
              : undefined;

            const createResult = yield* iam.createPolicy({
              PolicyName: props.name,
              PolicyDocument: props.policy,
              Path: props.path,
              Description: props.description,
              Tags: tags,
            });
            // FIXME: what error handling / retry logic should we have here?
            // no retry logic, that should be in itty
            // this should return a policy if it succeeded -- what's in the return below should move up here (the data at least)
            // and error if not
            return createResult;
          });

          Effect.runPromise(createEffect).then((resultPolicy) => {
            console.log("created iam policy!");
            return this({
              ...props,
              arn: resultPolicy.Policy?.Arn || "",
              policyId: resultPolicy.Policy?.PolicyId || "",
            });
          });
        }
      }),
      Match.when("update", () => {
        console.log("do update");
        // ensure the input properties are consistent with the existing policy
      }),
      Match.when("delete", () => {
        console.log("do delete");

        const policyArn = this.output?.arn;

        // if there's no ARN, there's nothing to delete in AWS
        // just destroy the local state
        if (!policyArn) {
          return this.destroy();
        }

        // Execute deletion with proper error handling
        const deleteEffect = Effect.gen(function* () {
          // List and delete all non-default versions first
          const versionsResult = yield* iam.listPolicyVersions({
            PolicyArn: policyArn,
          });

          const versions = versionsResult.Versions || [];

          // Delete non-default versions
          for (const version of versions) {
            if (!version.IsDefaultVersion && version.VersionId) {
              yield* iam.deletePolicyVersion({
                PolicyArn: policyArn,
                VersionId: version.VersionId,
              });
            }
          }

          // // Delete the policy itself
          yield* iam
            .deletePolicy({
              PolicyArn: policyArn,
            })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed("Policy doesn't exist"),
              ),
            );
        });

        // FIXME: how should we be handling errors? this can fail for example if the policy is attached to a user or role
        Effect.runPromise(deleteEffect).then(() =>
          console.log("deleted iam policy!"),
        );

        return this.destroy();
      }),
    );

    // FIXME: adding this just to satisfy this promise
    return this({
      ...props,
      policy.
    });
  },
);
