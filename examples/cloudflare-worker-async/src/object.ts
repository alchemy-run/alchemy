import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

export class ClaudeCode extends DurableObject {
  constructor(state: DurableObjectState, env: WorkerEnv) {
    super(state, env);
  }
}
