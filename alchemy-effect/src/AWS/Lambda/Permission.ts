import type * as lambda from "distilled-aws/lambda";
import { Resource } from "../../Resource.ts";

export type { FunctionUrlAuthType } from "distilled-aws/lambda";

export interface PermissionProps {
  /**
   * The action that the principal can use on the function.
   * For example, `lambda:InvokeFunction` or `lambda:GetFunction`.
   */
  action: string;

  /**
   * The name or ARN of the Lambda function, version, or alias.
   */
  functionName: string;

  /**
   * The AWS service, AWS account, IAM user, or IAM role that invokes the function.
   * If you specify a service, use `sourceArn` or `sourceAccount` to limit who can
   * invoke the function through that service.
   */
  principal: string;

  /**
   * For Alexa Smart Home functions, a token that the invoker must supply.
   */
  eventSourceToken?: string;

  /**
   * The type of authentication that your function URL uses.
   * Set to `AWS_IAM` to restrict access to authenticated users only.
   * Set to `NONE` to bypass IAM authentication to create a public endpoint.
   */
  functionUrlAuthType?: lambda.FunctionUrlAuthType;

  /**
   * Indicates whether the permission applies when the function is invoked
   * through a function URL.
   */
  invokedViaFunctionUrl?: boolean;

  /**
   * The identifier for your organization in AWS Organizations.
   * Use this to grant permissions to all the AWS accounts under this organization.
   */
  principalOrgID?: string;

  /**
   * For AWS services, the ID of the AWS account that owns the resource.
   * Use this together with `sourceArn` to ensure that the specified account owns the resource.
   */
  sourceAccount?: string;

  /**
   * For AWS services, the ARN of the AWS resource that invokes the function.
   * For example, an Amazon S3 bucket or Amazon SNS topic.
   */
  sourceArn?: string;
}

export interface Permission extends Resource<
  "AWS.Lambda.Permission",
  PermissionProps,
  {
    /** The statement ID of the permission. */
    statementId: string;
    /** The function name or ARN the permission is attached to. */
    functionName: string;
  }
> {}

/**
 * A Lambda permission that grants an AWS service or another account permission to
 * invoke a function.
 *
 * @section Granting Permissions
 * @example S3 Notification Permission
 * ```typescript
 * const perm = yield* Permission("S3Invoke", {
 *   action: "lambda:InvokeFunction",
 *   functionName: yield* fn.functionArn(),
 *   principal: "s3.amazonaws.com",
 *   sourceArn: yield* bucket.bucketArn,
 *   sourceAccount: yield* Account,
 * });
 * ```
 *
 * @example Cross Account Invoke
 * ```typescript
 * const perm = yield* Permission("CrossAccount", {
 *   action: "lambda:InvokeFunction",
 *   functionName: yield* fn.functionArn(),
 *   principal: "123456789012",
 * });
 * ```
 *
 * @example Public Function URL
 * ```typescript
 * const perm = yield* Permission("PublicUrl", {
 *   action: "lambda:InvokeFunctionUrl",
 *   functionName: yield* fn.functionArn(),
 *   principal: "*",
 *   functionUrlAuthType: "NONE",
 * });
 * ```
 */
export const Permission = Resource<Permission>("AWS.Lambda.Permission");
