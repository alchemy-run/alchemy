import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

// On-demand TPU VMs have no capacity on the testing project: v2-8 creates fail
// with "Insufficient capacity. Try again in a different zone" in
// us-central1-b/c/f, v5litepod-1 with "There is no more capacity in the zone
// \"us-central1-a\"", and v6e-1 with "User does not have permission to submit
// requests for accelerator type". Set GCP_TEST_TPU_NODE=1 where a v2-8 fits.
export const nodeCapacity = !!process.env.GCP_TEST_TPU_NODE && !process.env.FAST;

export const Trainer = GCP.TPU.Node("Trainer", {
  location: "us-central1-c",
  acceleratorType: "v2-8",
  runtimeVersion: "tpu-ubuntu2204-base",
});

export const QueuedTrainer = GCP.TPU.QueuedResource("QueuedTrainer", {
  location: "us-central1-c",
  nodeSpec: [
    {
      node: {
        acceleratorType: "v2-8",
        runtimeVersion: "tpu-ubuntu2204-base",
      },
    },
  ],
});

const nodeProbes = Effect.gen(function* () {
  const getNode = yield* GCP.TPU.GetNode(Trainer);
  return {
    getNode: getNode().pipe(
      Effect.map((node) => ({ name: node.name, acceleratorType: node.acceleratorType })),
    ),
  };
});

/**
 * Effect-native Cloud Run service exercising every Cloud TPU binding as
 * its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class TpuBindingsHost extends GCP.Function<TpuBindingsHost>()(
  "TpuBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: { GCP_TEST_TPU_NODE: nodeCapacity ? "1" : "" },
  },
  Effect.gen(function* () {
    const node = nodeCapacity ? yield* nodeProbes : {};
    const getQueuedResource = yield* GCP.TPU.GetQueuedResource(QueuedTrainer);

    return {
      fetch: serveProbes({
        ...node,
        getQueuedResource: getQueuedResource().pipe(
          Effect.map((resource) => ({ name: resource.name })),
        ),
      }),
    };
  }).pipe(Effect.provide(GCP.TPU.GetNodeHttp), Effect.provide(GCP.TPU.GetQueuedResourceHttp)),
) {}
