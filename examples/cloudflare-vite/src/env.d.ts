/// <reference types="./env.d.ts" />

import type { api } from "../alchemy.config";

type CloudFlareEnv = typeof api.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudFlareEnv {}
  }
}
