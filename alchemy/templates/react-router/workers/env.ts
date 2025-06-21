import type { website } from "../alchemy.run.js";

export type CloudflareEnv = typeof website.Env;

declare global {
  type Env = CloudflareEnv
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}