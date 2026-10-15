import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { PlainDispatchObject } from "./dispatch-object.ts";
import { dispatchImplementation, dispatchOptions } from "./dispatch-runtime.ts";

export default Cloudflare.Worker(
  "PlainDispatchWorker",
  {
    ...dispatchOptions,
    main: import.meta.url,
    observability: { ...dispatchOptions.observability, traces: { enabled: false } },
  },
  dispatchImplementation(PlainDispatchObject, false).pipe(
    Effect.provide(Cloudflare.Workers.VersionMetadataBinding),
  ),
);
