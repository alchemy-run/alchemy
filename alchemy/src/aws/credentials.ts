import { alchemy } from "../alchemy.ts";
import { isSecret } from "../secret.ts";
import type { AwsClientProps } from "./client-props.ts";

/**
 * Validate AWS client properties to ensure they are strings.
 * This follows the same pattern as Cloudflare credential validation.
 */
function validateAwsClientProps(props: AwsClientProps, context: string): void {
  const validKeys = [
    "accessKeyId",
    "secretAccessKey",
    "sessionToken",
    "region",
    "profile",
    "roleArn",
    "externalId",
    "roleSessionName",
  ];

  for (const [key, value] of Object.entries(props)) {
    if (!validKeys.includes(key)) {
      continue; // Ignore unknown properties
    }

    if (value !== undefined && typeof value !== "string" && !isSecret(value)) {
      throw new Error(
        `Invalid AWS configuration in ${context}: Property '${key}' must be a string or Secret, got ${typeof value}. ` +
          "Please ensure all AWS credential properties are strings or Secret objects.",
      );
    }
  }
}

/**
 * Get global AWS configuration from environment variables.
 * This provides the base layer of AWS credential configuration.
 */
export function getGlobalAwsConfig(): AwsClientProps {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID
      ? alchemy.secret(process.env.AWS_ACCESS_KEY_ID)
      : undefined,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      ? alchemy.secret(process.env.AWS_SECRET_ACCESS_KEY)
      : undefined,
    sessionToken: process.env.AWS_SESSION_TOKEN
      ? alchemy.secret(process.env.AWS_SESSION_TOKEN)
      : undefined,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    profile: process.env.AWS_PROFILE,
    roleArn: process.env.AWS_ROLE_ARN,
    externalId: process.env.AWS_EXTERNAL_ID,
    roleSessionName: process.env.AWS_ROLE_SESSION_NAME,
  };
}

/**
 * Resolve AWS credentials using three-tier resolution: global → scope → resource.
 *
 * This function implements a comprehensive credential resolution system that allows
 * for flexible AWS credential management across different levels of your application.
 * It enables multi-account and multi-region deployments by providing a consistent
 * way to override credentials at different scopes.
 *
 * The resolution follows this precedence order:
 * 1. Resource-level credentials (highest priority)
 * 2. Scope-level credentials (medium priority)
 * 3. Global environment variables (lowest priority)
 *
 * Supported credential properties include:
 * - `region`: AWS region (e.g., 'us-west-2', 'eu-central-1')
 * - `profile`: AWS profile name from credentials file
 * - `accessKeyId`: AWS access key ID
 * - `secretAccessKey`: AWS secret access key
 * - `sessionToken`: AWS session token for temporary credentials
 * - `roleArn`: AWS role ARN to assume
 * - `roleSessionName`: Session name when assuming a role
 * - `externalId`: External ID when assuming a role
 *
 * @param resourceProps - Resource-level AWS credential properties (optional)
 * @returns Resolved AWS client properties with validation
 *
 * @throws {Error} When scope contains invalid AWS configuration
 * @throws {Error} When resource properties contain invalid AWS configuration
 *
 * @example
 * ```typescript
 * // Basic usage with resource-level credentials
 * const credentials = resolveAwsCredentials({
 *   region: "us-west-2",
 *   profile: "production"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Usage with scope-level credentials
 * await alchemy.run("my-app", {
 *   aws: {
 *     region: "eu-west-1",
 *     profile: "staging"
 *   }
 * }, async () => {
 *   // Resources created here will use the scope credentials by default
 *   const vpc = await Vpc("main-vpc", {
 *     cidrBlock: "10.0.0.0/16"
 *   });
 *
 *   // Resources can override scope credentials
 *   const crossRegionSubnet = await Subnet("cross-region-subnet", {
 *     vpc,
 *     cidrBlock: "10.0.1.0/24",
 *     region: "us-east-1" // Override scope region
 *   });
 * });
 * ```
 */
export async function resolveAwsCredentials(
  resourceProps?: AwsClientProps,
): Promise<AwsClientProps> {
  // 1. Start with global environment variables (lowest priority)
  const globalConfig = getGlobalAwsConfig();

  // 2. Layer in scope-level credentials (medium priority)
  let scopeConfig: AwsClientProps = {};
  try {
    // Import Scope dynamically to avoid circular dependency
    const { Scope } = await import("../scope.ts");
    const currentScope = Scope.getScope();
    if (currentScope?.providerCredentials?.aws) {
      scopeConfig = currentScope.providerCredentials.aws;

      // Validate scope-level credentials if provided
      validateAwsClientProps(scopeConfig, "scope");
    }
  } catch (error) {
    // If we can't access scope (e.g., not running in scope context), just continue
    // with empty scope config unless it's a validation error
    if (
      error instanceof Error &&
      error.message.includes("Invalid AWS configuration")
    ) {
      throw error;
    }
  }

  // 3. Layer in resource-level credentials (highest priority)
  const resourceConfig = resourceProps || {};

  // Validate resource-level credentials if provided
  if (resourceProps && Object.keys(resourceProps).length > 0) {
    validateAwsClientProps(resourceProps, "resource properties");
  }

  // Merge configurations with proper precedence (later properties override earlier ones)
  const resolvedConfig = {
    ...globalConfig,
    ...scopeConfig,
    ...resourceConfig,
  };

  // Filter out undefined values from the final result
  return Object.fromEntries(
    Object.entries(resolvedConfig).filter(([_, value]) => value !== undefined),
  ) as AwsClientProps;
}
