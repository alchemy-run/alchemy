import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  return {
    main: import.meta.filename,
  } as Cloudflare.WorkerProps;
}).pipe(Cloudflare.Worker("JobWorker"));
