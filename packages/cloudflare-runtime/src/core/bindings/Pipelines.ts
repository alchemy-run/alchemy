import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, pipeline: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "pipelines",
      pipeline,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";
import { loadInternalWorker } from "../internal/internal-worker.ts";
import { formatExtensionModule } from "../internal/internal-modules.ts";
import * as R2 from "./r2-bucket/R2Bucket.ts";
import type { LocalPipelinesProps } from "./PipelinesOptions.shared.ts";
export * from "./PipelinesOptions.shared.ts";

export class Pipelines extends Plugin.Service<Pipelines, {}>()(
  "cloudflare-runtime/plugin/Pipelines",
) {}

export const PipelinesLive = Layer.effect(
  Pipelines,
  Effect.gen(function* () {
    const esModule = yield* formatExtensionModule({
      worker: () =>
        loadInternalWorker(
          "#cloudflare-runtime-core-worker/bindings/Pipelines.worker",
        ),
    });
    return Pipelines.of({
      api: {},
      extensions: [
        {
          modules: [
            { name: "cloudflare-runtime:pipelines", internal: true, esModule },
          ],
        },
      ],
    });
  }),
);

/** Local batches flush to R2 on send; advanced SQL and timed rolling are rejected. */
export const local = (
  props: LocalPipelinesProps,
): BindingHook<Pipelines | R2.R2Bucket> =>
  Plugin.use(Pipelines, () =>
    Effect.gen(function* () {
      const sinks = yield* Effect.forEach(props.routes, (route, index) =>
        R2.local({ binding: `SINK_${index}`, id: route.bucket }),
      );
      return {
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-runtime:pipelines",
          innerBindings: [
            { name: "PROPS", json: JSON.stringify(props) },
            ...sinks,
          ],
        },
      };
    }),
  );
