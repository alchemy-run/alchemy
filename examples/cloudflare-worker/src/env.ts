import type { worker } from "../alchemy.run.js";

export type Env = typeof worker.Env;
declare global {
  export type CloudflareEnv = typeof worker.Env;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
