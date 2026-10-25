import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Job, JobService } from "./JobService.ts";

// #region show
export const JobServiceKV = Layer.effect(
  JobService,
  Effect.gen(function* () {
    const jobs = yield* Cloudflare.KV.Namespace("Jobs");
    const store = yield* Cloudflare.KV.ReadWriteNamespace(jobs);
    return {
      getJob: (id: string) => store.get<Job>(id, "json") /*hide*/.pipe(Effect.orDie) /*end*/,
    };
  }),
) /*hide*/.pipe(Layer.provide(Cloudflare.KV.ReadWriteNamespaceBinding)) /*end*/;
// #endregion show
