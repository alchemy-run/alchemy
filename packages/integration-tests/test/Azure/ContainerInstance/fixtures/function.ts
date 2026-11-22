import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/**
 * Container group the bindings start, stop, and restart. Module-scope so the
 * test stack yields the same declaration. 0.5 vCPU / 0.5 GB, no public IP.
 */
export const Worker = Azure.ContainerInstance.ContainerGroup("AciBindingsWorker", {
  restartPolicy: "Always",
  containers: [
    {
      name: "web",
      image: "mcr.microsoft.com/azuredocs/aci-helloworld",
      cpu: 0.5,
      memoryInGB: 0.5,
      ports: [{ port: 80 }],
    },
  ],
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Container Instances
 * runtime-action binding on a managed-identity host, one route per binding.
 */
export default class AciFunction extends Azure.Functions.Function<AciFunction>()(
  "AciBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    const start = yield* Azure.ContainerInstance.StartContainerGroup(worker);
    const stop = yield* Azure.ContainerInstance.StopContainerGroup(worker);
    const restart = yield* Azure.ContainerInstance.RestartContainerGroup(worker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/start":
            return yield* respond(start());
          case "/stop":
            return yield* respond(stop());
          case "/restart":
            return yield* respond(restart());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerInstance.StartContainerGroupHttp,
        Azure.ContainerInstance.StopContainerGroupHttp,
        Azure.ContainerInstance.RestartContainerGroupHttp,
      ),
    ),
  ),
) {}
