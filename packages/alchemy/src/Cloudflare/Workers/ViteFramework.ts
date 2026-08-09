/**
 * Let a Vite framework contribute its generated Worker entry and Durable
 * Object declarations to Alchemy's injected Cloudflare runtime plugin.
 *
 * Add {@link cloudflareViteFramework} after the framework's Vite plugin. The
 * framework contributes configuration only: Alchemy remains the single owner
 * of the Cloudflare plugin, local workerd runtime, bindings, and production
 * Durable Object migrations.
 */
export {
  cloudflareViteFramework,
  type ViteFrameworkContribution,
  type ViteFrameworkDurableObject,
  type ViteFrameworkWorkerCustomizer,
} from "@alchemy.run/cloudflare-runtime/vite";
