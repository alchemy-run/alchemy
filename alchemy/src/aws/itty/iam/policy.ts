import * as Effect from "effect/Effect";
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
   * Name of the Policy.
   */
  name: string;

  /**
   * ID of the default policy version
   */
  defaultVersionId: string;

  /**
   * Number of entities the policy is attached to
   */
  attachmentCount: number;

  /**
   * When the policy was created
   */
  createDate: string;

  /**
   * When the policy was last updated
   */
  updateDate: string;

  /**
   * Whether the policy can be attached to IAM users/roles
   */
  isAttachable: boolean;
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

    // if a resource's immutable property is updated, it needs to trigger a replacement of the resource
    // https://alchemy.run/concepts/resource/#trigger-replacement
    if (this.phase === "update" && this.output.name !== this.props.name) {
      // calling this.replace() will terminate this run and re-invoke it 
      // with the "create" phase
      this.replace();
    }

    if (this.phase === "delete") {
      //console.log("do delete");

        const policyArn = this.output.arn;

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
        Effect.runPromise(deleteEffect);

        // this.destroy() should really only be called if the deletePolicy call was successful
        return this.destroy();
    }

    if (this.phase === "create") {
      //console.log("do create");

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
        }).pipe(
          // Effect.tap((response) => Console.log(`got successful response: ${JSON.stringify(response, null, 2)}`)),
          Effect.flatMap((createPolicyResponse) => {
            return iam.getPolicy({ PolicyArn: createPolicyResponse!.Policy!.Arn!});
          }),
          // FIXME: too broad
          Effect.catchAllCause((err) => Effect.fail(new Error(`failing from error: ${err}`))),
        );
        // FIXME: what error handling / retry logic should we have here?
        // no retry logic, that should be in itty
        // this should return a policy if it succeeded -- what's in the return below should move up here (the data at least)
        // and error if not
        return createResult;
      });

      Effect.runPromise(createEffect).then((resultPolicy) => {
        const p = resultPolicy!.Policy!;
        return this({
          ...props,
          arn: p.Arn!,
          defaultVersionId: p.DefaultVersionId!,
          attachmentCount: p.AttachmentCount!,
          createDate: p.CreateDate!.toString(),
          updateDate: p.UpdateDate!.toString(),
          isAttachable: p.IsAttachable!, 
        });
      });
    }

    if (this.phase === "update") {
      console.log("do update");
      //policyArn = this.props.arn;
        // ensure the input properties are consistent with the existing policy
      // const policyArn = this.output?.arn;
    }

    // this shouldn't ever return but we need to satisfy the return promise on this method.
    // can this be improved??
    return this({
        ...props,
        arn: "arn",
        defaultVersionId: "default version",
        attachmentCount: 0,
        createDate: "some date",
        updateDate: "some other date",
        isAttachable: true, 
      });
  },
);
