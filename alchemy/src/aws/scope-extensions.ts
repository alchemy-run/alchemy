import type { AwsClientProps } from "./client-props.ts";

/**
 * AWS scope extensions - adds AWS credential support to scope options.
 * This uses TypeScript module augmentation to extend the scope interfaces directly.
 */
declare module "../scope.ts" {
  interface ProviderCredentials {
    /**
     * AWS credentials configuration for this scope.
     * All AWS resources created within this scope will inherit these credentials
     * unless overridden at the resource level.
     */
    aws?: AwsClientProps;
  }

  interface ExtendedScopeOptions {
    /**
     * AWS credentials configuration for this scope.
     */
    aws?: AwsClientProps;
  }
}

declare module "../alchemy.ts" {
  interface RunOptions {
    /**
     * AWS credentials configuration for this scope.
     */
    aws?: AwsClientProps;
  }
}
