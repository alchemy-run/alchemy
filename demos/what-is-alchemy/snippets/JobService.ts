import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface Job {
  id: string;
  status: string;
}

// #region show
export class JobService extends Context.Service<
  JobService,
  { getJob(id: string): Effect.Effect<Job | null, never, Alchemy.RuntimeContext> }
>()("JobService") {}
// #endregion show
