import * as Effect from "effect/Effect";

import type { Input } from "../Input.ts";
import type { Environment } from "./Environment.ts";
import { Variable } from "./Variable.ts";

export interface VariablesProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Optional environment. When set every variable is scoped to that GitHub
   * Actions environment instead of the whole repository. Accepts an
   * environment name or a `GitHub.Environment` resource.
   */
  environment?: string | Environment;

  /**
   * Map of variable name to value. Each entry becomes one
   * `GitHub.Variable` resource, using the map key as both the alchemy
   * logical id and the variable name.
   */
  variables: Record<string, Input<string>>;
}

/**
 * Bulk-creates a set of {@link Variable}s in the same repository.
 *
 * Plural counterpart of {@link import("./Secrets.ts").Secrets}, for
 * non-sensitive values like region names, role ARNs, environment labels,
 * or feature flags.
 *
 * ### Basic Usage
 * **Example:** Repository Variables
 * ```ts
 * yield* GitHub.Variables({
 *   owner: "my-org",
 *   repository: "my-repo",
 *   variables: {
 *     AWS_ROLE_ARN: role.roleArn,
 *     AWS_REGION: "us-east-1",
 *     DEPLOY_STAGE: "production",
 *   },
 * });
 * ```
 *
 * ### Environment-Scoped Variables
 * **Example:** Production Environment Configuration
 * ```ts
 * const production = yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 * });
 *
 * yield* GitHub.Variables({
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: production,
 *   variables: {
 *     CDN_URL: distribution.domainName,
 *     API_URL: worker.url,
 *     LOG_LEVEL: "info",
 *   },
 * });
 * ```
 *
 * ### Wiring Infrastructure Outputs
 * **Example:** Share Deployed Resource Identifiers
 * ```ts
 * const bucket = yield* AWS.S3.Bucket("assets", {});
 * const table = yield* AWS.DynamoDB.Table("users", {});
 * const queue = yield* AWS.SQS.Queue("events", {});
 *
 * yield* GitHub.Variables({
 *   owner: "my-org",
 *   repository: "my-repo",
 *   variables: {
 *     S3_BUCKET: bucket.bucketName,
 *     DYNAMODB_TABLE: table.tableName,
 *     SQS_QUEUE_URL: queue.queueUrl,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Variables = ({
  owner,
  repository,
  environment,
  variables,
}: VariablesProps) =>
  Effect.all(
    Object.entries(variables).map(([name, value]) =>
      Variable(name, {
        owner,
        repository,
        environment,
        name,
        value,
      }),
    ),
  );
