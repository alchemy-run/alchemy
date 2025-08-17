import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { GetPlatformProxyOptions } from "wrangler";
import { getPlatformProxyOptions } from "../cloudflare-env-proxy.ts";

/**
 * Performs some initial setup to integrate as best as possible the local Next.js dev server (run via next dev) with the open-next Cloudflare adapter
 *
 * Note: this function should only be called inside the Next.js config file, and although async it doesn't need to be awaited
 *
 * @param options — options on how the function should operate and if/where to persist the platform data
 */
export function initAlchemyNextjs(options: GetPlatformProxyOptions = {}) {
  return initOpenNextCloudflareForDev(getPlatformProxyOptions(options));
}
