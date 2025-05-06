/// <reference types="@cloudflare/workers-types" />
import type { worker } from "./alchemy.run.js";

export type WorkerEnv = typeof worker.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
