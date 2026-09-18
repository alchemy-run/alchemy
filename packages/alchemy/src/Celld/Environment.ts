import * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import { getRefMetadata, isRef } from "../Ref.ts";
import { isResource, isResourceOfType } from "../Resource.ts";
import type { CelldBinding } from "./DeploymentConfig.ts";
import { isNamespace } from "./KV/Namespace.ts";
import { isBucket } from "./R2/Bucket.ts";
import { isQueue } from "./Queues/Queue.ts";
import { isDatabase } from "./D1/Database.ts";
import { storageBinding, type StorageBinding } from "./KV/StorageBinding.ts";
import type { CelldWorker } from "./Worker.ts";

const isWorker = (value: unknown): value is CelldWorker =>
  isResourceOfType(value, "Celld.Worker");

const fleetMetadata = (
  resource: Parameters<typeof storageBinding>[0],
): Input<StorageBinding> => ({
  ...storageBinding(resource),
  // Persisted attributes do not contain FQN; references already know their declaration ID.
  resource: Output.isOutput(resource)
    ? Output.isRefExpr(resource)
      ? resource.resourceId
      : resource.FQN
    : isRef(resource)
      ? getRefMetadata(resource).id
      : resource.FQN,
});

/** Lower explicit resource-valued environment entries without resolving attribute Outputs. */
export const lowerEnvironment = (values: Record<string, unknown>) =>
  Effect.gen(function* () {
    const entries: [string, unknown][] = [];
    const bindings: Input<CelldBinding>[] = [];
    const storageBindings: Input<StorageBinding>[] = [];
    for (const [name, input] of Object.entries(values)) {
      const deferred = Output.isOutput(input) || isRef(input);
      const value = !deferred && Effect.isEffect(input) ? yield* input : input;
      const resource =
        Output.isOutput(value) || isResource(value) || isRef(value);
      if (resource && isNamespace(value)) {
        bindings.push({
          type: "kv_namespace",
          name,
          namespaceId: value.namespaceId,
        });
        storageBindings.push(fleetMetadata(value));
      } else if (resource && isBucket(value)) {
        bindings.push({
          type: "r2_bucket",
          name,
          bucketName: value.bucketName,
        });
        storageBindings.push(fleetMetadata(value));
      } else if (resource && isQueue(value)) {
        bindings.push({ type: "queue", name, queueName: value.queueName });
        storageBindings.push(fleetMetadata(value));
      } else if (resource && isDatabase(value)) {
        bindings.push({
          type: "d1",
          name,
          id: value.databaseId,
          databaseName: value.databaseName,
        });
        storageBindings.push(fleetMetadata(value));
      } else if (resource && isWorker(value)) {
        bindings.push({ type: "service", name, service: value.workerName });
        storageBindings.push(fleetMetadata(value));
      } else {
        entries.push([name, value]);
      }
    }
    return { env: Object.fromEntries(entries), bindings, storageBindings };
  });
