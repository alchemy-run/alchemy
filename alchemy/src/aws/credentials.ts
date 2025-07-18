import { Scope } from "../scope.ts";
import { AwsClientPropsSchema, type AwsClientProps } from "./client-props.ts";

/**
 * Get global AWS configuration from environment variables.
 * This provides the base layer of AWS credential configuration.
 */
export function getGlobalAwsConfig(): AwsClientProps {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
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
 * 2. Scope-level credentials from metadata
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
 * @param scope - Current scope for accessing metadata (optional, defaults to current scope)
 * @returns Resolved AWS client properties with validation
 *
 * @throws {Error} When scope metadata contains invalid AWS configuration
 * @throws {Error} When resource properties contain invalid AWS configuration
 *
 * @example
 * ```typescript
 * // Basic usage with resource-level credentials
 * const credentials = resolveAwsCredentials({
 *   region: "us-west-2",
 *   profile: "production"
 * });
 *
 * // Create EC2 client with resolved credentials
 * const ec2Client = await createEC2Client(credentials);
 * ```
 *
 * @example
 * ```typescript
 * // Usage with scope metadata
 * const app = await alchemy.run("my-app", {
 *   // Scope-level AWS credential overrides
 *   awsRegion: "eu-west-1",
 *   awsProfile: "staging"
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
 *
 * @example
 * ```typescript
 * // Multi-account deployment example
 * await alchemy.run("production", {
 *   awsRegion: "us-west-2",
 *   awsProfile: "main-account"
 * }, async () => {
 *   // This resource uses scope credentials (main-account)
 *   const mainVpc = await Vpc("main-vpc", {
 *     cidrBlock: "10.0.0.0/16"
 *   });
 *
 *   // This resource overrides to use a different account
 *   const secondaryVpc = await Vpc("secondary-vpc", {
 *     cidrBlock: "10.1.0.0/16",
 *     profile: "secondary-account",
 *     region: "us-east-1"
 *   });
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Using explicit credentials
 * const credentials = resolveAwsCredentials({
 *   accessKeyId: "AKIAIOSFODNN7EXAMPLE",
 *   secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
 *   region: "us-west-2"
 * });
 * ```
 */
export function resolveAwsCredentials(
  resourceProps?: AwsClientProps,
  scope?: Scope,
): AwsClientProps {
  // Get the current scope if not provided
  const currentScope = scope || Scope.getScope();

  // 1. Start with global environment variables (lowest priority)
  const globalConfig = getGlobalAwsConfig();

  // 2. Layer in scope-level credentials from metadata (medium priority)
  let scopeConfig: AwsClientProps = {};
  if (currentScope?.metadata) {
    // Extract AWS-related properties from scope metadata
    const potentialAwsConfig = {
      accessKeyId:
        currentScope.metadata.awsAccessKeyId ||
        currentScope.metadata.accessKeyId,
      secretAccessKey:
        currentScope.metadata.awsSecretAccessKey ||
        currentScope.metadata.secretAccessKey,
      sessionToken:
        currentScope.metadata.awsSessionToken ||
        currentScope.metadata.sessionToken,
      region: currentScope.metadata.awsRegion || currentScope.metadata.region,
      profile:
        currentScope.metadata.awsProfile || currentScope.metadata.profile,
      roleArn:
        currentScope.metadata.awsRoleArn || currentScope.metadata.roleArn,
      externalId:
        currentScope.metadata.awsExternalId || currentScope.metadata.externalId,
      roleSessionName:
        currentScope.metadata.awsRoleSessionName ||
        currentScope.metadata.roleSessionName,
    };

    // Filter out undefined values
    scopeConfig = Object.fromEntries(
      Object.entries(potentialAwsConfig).filter(
        ([_, value]) => value !== undefined,
      ),
    ) as AwsClientProps;

    // Validate scope metadata if it contains AWS configuration
    if (Object.keys(scopeConfig).length > 0) {
      const validationResult = AwsClientPropsSchema(scopeConfig);

      // Check if validation failed (arktype v2 returns array-like errors on failure)
      if (Array.isArray(validationResult)) {
        const errorMessages = validationResult
          .map((error) => error.message || error.toString())
          .join(", ");

        throw new Error(
          `Invalid AWS configuration in scope metadata: ${errorMessages}. ` +
            "Please ensure all AWS credential properties are strings.",
        );
      }

      // Validation succeeded, use the validated result
      scopeConfig = validationResult as AwsClientProps;
    }
  }

  // 3. Layer in resource-level credentials (highest priority)
  const resourceConfig = resourceProps || {};

  // Validate resource-level credentials if provided
  if (resourceProps && Object.keys(resourceProps).length > 0) {
    const validationResult = AwsClientPropsSchema(resourceProps);

    // Check if validation failed (arktype v2 returns array-like errors on failure)
    if (Array.isArray(validationResult)) {
      const errorMessages = validationResult
        .map((error) => error.message || error.toString())
        .join(", ");

      throw new Error(
        `Invalid AWS configuration in resource properties: ${errorMessages}. ` +
          "Please ensure all AWS credential properties are strings.",
      );
    }
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
