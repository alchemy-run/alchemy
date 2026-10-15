import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TracedDispatchObject } from "./dispatch-object.ts";
import { dispatchImplementation, dispatchOptions } from "./dispatch-runtime.ts";

export default Cloudflare.Worker(
  "TracedDispatchWorker",
  {
    ...dispatchOptions,
    main: import.meta.url,
    observability: {
      ...dispatchOptions.observability,
      traces: { enabled: true, headSamplingRate: 1, persist: true },
    },
  },
  dispatchImplementation(TracedDispatchObject, true).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Workers.VersionMetadataBinding,
        Cloudflare.Telemetry({ headSamplingRate: 1, persist: true }),
      ),
    ),
  ),
);
