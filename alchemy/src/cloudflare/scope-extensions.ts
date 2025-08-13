import type { CloudflareApiOptions } from "./api.ts";

/**
 * Cloudflare scope extensions - adds Cloudflare credential support to scope options.
 * This uses TypeScript module augmentation to extend the ProviderCredentials interface.
 */
declare module "../scope.ts" {
  interface ProviderCredentials {
    /**
     * Cloudflare credentials configuration for this scope.
     * All Cloudflare resources created within this scope will inherit these credentials
     * unless overridden at the resource level.
     */
    cloudflare?: CloudflareApiOptions;
  }
}
