/// <reference types="./env.d.ts" />

import type { worker } from "../alchemy.run";

export type CloudFlareEnv = typeof worker.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudFlareEnv {}
  }
}
