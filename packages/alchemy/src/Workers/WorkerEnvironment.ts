import * as Context from "effect/Context";

/**
 * The runtime environment record the worker was deployed with — workerd's
 * `env` object.
 */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, any>>()(
  "Cloudflare.Workers.WorkerEnvironment",
) {}
