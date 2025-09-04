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
  name?: string;

  /**
   * The path for the policy
   * @default "/"
   */
  path?: string;

  /**
   * The policy document as a JSON string
   */
  policy: string | object;

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
    // NOTE: in update phase, `this.props` are the OLD props; compare against incoming `props` instead.
    if (
      this.phase === "update" &&
      ((props.name !== undefined && this.output.name !== props.name) ||
        (props.path !== undefined && this.output.path !== props.path))
    ) {
      // calling this.replace() will terminate this run and re-invoke this method
      // with the "create" phase
      return this.replace();
    }

    if (this.phase === "delete") {

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

          // Delete the policy itself
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
        await Effect.runPromise(deleteEffect);
        return this.destroy();
    }

    if (this.phase === "create") {
      // Resolve defaults
      // FIXME: should this use scope.createPhysicalName()?
      const resolvedName = props.name ?? `${this.scope.appName}-${this.stage}-${_id}`;
      const resolvedPath = props.path ?? "/";
      const policyDoc = typeof props.policy === "string" ? props.policy : JSON.stringify(props.policy);

      const createEffect = Effect.gen(function* () {
        const tags = props.tags
          ? Object.entries(props.tags).map(([Key, Value]) => ({
              Key,
              Value,
            }))
          : undefined;

        const createResult = yield* iam.createPolicy({
          PolicyName: resolvedName,
          PolicyDocument: policyDoc,
          Path: resolvedPath,
          Description: props.description,
          Tags: tags,
        }).pipe(
          // FIXME: too broad?
          Effect.catchAll((err) => Effect.fail(new Error(`failing from error: ${err}`))),
        );
        // FIXME: what error handling / retry logic should we have here?
        // no retry logic, that should be in itty
        // this should return a policy if it succeeded -- what's in the return below should move up here (the data at least)
        // and error if not
        return createResult;
      });

      const resultPolicy = await Effect.runPromise(createEffect);
      const p = resultPolicy!.Policy!;
      return this({
        ...props,
        name: resolvedName,
        path: resolvedPath,
        arn: p.Arn!,
        defaultVersionId: p.DefaultVersionId!,
        attachmentCount: p.AttachmentCount!,
        createDate: p.CreateDate!.toString(),
        updateDate: p.UpdateDate!.toString(),
        isAttachable: p.IsAttachable!,
      });
    }

    if (this.phase === "update") {
      // Update policy document by creating a new default version when content changes
      const policyArn = this.output.arn;
      const currentDefaultVersionId = this.output.defaultVersionId;

      // If policy JSON changed, create a new version and set as default
      const newDoc = typeof props.policy === "string" ? props.policy : JSON.stringify(props.policy);
      // We can't easily diff normalized JSON reliably here; optimistically create a new version.
      // Optionally, callers can avoid unnecessary updates by keeping props stable.
      const updateEffect = Effect.gen(function* () {
        // Fetch updated policy metadata
        const versionsResult = yield* iam.listPolicyVersions({ PolicyArn: policyArn });
        const versions = versionsResult.Versions ?? [];

        // Create a new version as default
        const created = yield* iam.createPolicyVersion({
          PolicyArn: policyArn,
          PolicyDocument: newDoc,
          SetAsDefault: true,
        });

        // If we exceed AWS limit (5), prune the oldest non-default version
        const nonDefault = versions.filter((v) => !v.IsDefaultVersion && v.VersionId);
        if (nonDefault.length >= 4) {
          // Sort by CreateDate asc and delete the oldest
          nonDefault.sort((a, b) =>
            (new Date(a.CreateDate ?? 0).getTime()) - (new Date(b.CreateDate ?? 0).getTime()),
          );
          const oldest = nonDefault[0];
          if (oldest?.VersionId) {
            yield* iam.deletePolicyVersion({ PolicyArn: policyArn, VersionId: oldest.VersionId });
          }
        }

        // Fetch updated policy metadata
        const updatedPolicy = yield* iam.getPolicy({ PolicyArn: policyArn });
        return updatedPolicy;
      });

      const updated = await Effect.runPromise(updateEffect);
      const p = updated!.Policy!;
      return this({
        ...props,
        name: this.output.name,
        path: this.output.path,
        arn: p.Arn!,
        defaultVersionId: p.DefaultVersionId ?? currentDefaultVersionId,
        attachmentCount: p.AttachmentCount!,
        createDate: p.CreateDate!.toString(),
        updateDate: p.UpdateDate!.toString(),
        isAttachable: p.IsAttachable!,
      });
    }

    // Should never reach here; all phases handled above.
    // If it does, consider it a logic error.
    throw new Error("Unhandled resource phase");
  },
);
