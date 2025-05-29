import type { website } from "../alchemy.run.ts";

declare global {
  type Env = typeof website.Env;
}

declare module "cloudflare:workers" {
  type _Env = Env
  namespace Cloudflare {
    export interface Env extends _Env {}
  }
}