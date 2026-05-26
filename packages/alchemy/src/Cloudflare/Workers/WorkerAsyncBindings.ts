import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import { isAnalyticsEngineDataset } from "../AnalyticsEngine/AnalyticsEngineDataset.ts";
import { isArtifacts } from "../Artifacts/Artifacts.ts";
import { isBrowserRendering } from "../BrowserRendering/BrowserRendering.ts";
import { isSendEmail } from "../Email/SendEmail.ts";
import { isHyperdrive } from "../Hyperdrive/Hyperdrive.ts";
import { getHyperdriveDevOrigin } from "../Hyperdrive/HyperdriveBinding.ts";
import { isImages } from "../Images/Images.ts";
import { isAssets } from "./Assets.ts";
import { isDurableObjectNamespaceLike } from "./DurableObjectNamespace.ts";
import type { WorkerBindingProps } from "./Worker.ts";
import { isWorker, type Worker, type WorkerProps } from "./Worker.ts";
import type { WorkerBinding, WorkerBindingResource } from "./WorkerBinding.ts";

export const bindWorkerAsyncBindings = Effect.fnUntraced(function* (
  resource: Worker,
  props: InputProps<WorkerProps<WorkerBindingProps>>,
) {
  if (props.bindings) {
    for (const bindingName in props.bindings) {
      // @ts-expect-error
      const bindingEff = props.bindings?.[bindingName] as
        | WorkerBindingResource
        | Effect.Effect<WorkerBindingResource>;
      // Bindings can be passed as a plain resource value, an Effect that
      // yields a resource, or an effect-class (e.g. a `Cloudflare.Worker`
      // class). Resolve the yieldable forms before deriving binding metadata.
      const binding = isYieldableEffectLike(bindingEff)
        ? ((yield* bindingEff as Effect.Effect<unknown>) as WorkerBindingResource)
        : bindingEff;

      const bindingMeta: InputProps<WorkerBinding> | undefined =
        typeof binding === "string"
          ? {
              type: "plain_text",
              name: bindingName,
              value: binding,
            }
          : Redacted.isRedacted(binding)
            ? {
                type: "secret_text",
                name: bindingName,
                value: Redacted.value(binding),
              }
            : isAssets(binding)
              ? {
                  type: "assets",
                  name: bindingName,
                }
              : isArtifacts(binding)
                ? ({
                    type: "artifacts",
                    name: bindingName,
                    namespace: binding.namespace,
                  } as any)
                : isImages(binding)
                  ? {
                      type: "images",
                      name: bindingName,
                    }
                  : isBrowserRendering(binding)
                    ? {
                        type: "browser",
                        name: bindingName,
                      }
                    : isAnalyticsEngineDataset(binding)
                      ? {
                          type: "analytics_engine",
                          name: bindingName,
                          dataset: binding.dataset,
                        }
                      : isSendEmail(binding)
                        ? {
                            type: "send_email",
                            name: bindingName,
                            destinationAddress: binding.destinationAddress,
                            allowedDestinationAddresses:
                              binding.allowedDestinationAddresses,
                            allowedSenderAddresses:
                              binding.allowedSenderAddresses,
                          }
                        : isDurableObjectNamespaceLike(binding)
                          ? {
                              type: "durable_object_namespace",
                              name: bindingName,
                              className: binding.className ?? binding.name,
                            }
                          : binding.Type === "Cloudflare.D1Database"
                            ? {
                                type: "d1",
                                id: binding.databaseId,
                                name: bindingName,
                              }
                            : binding.Type === "Cloudflare.R2Bucket"
                              ? {
                                  type: "r2_bucket",
                                  name: bindingName,
                                  bucketName: binding.bucketName,
                                  jurisdiction: binding.jurisdiction.pipe(
                                    Output.map((jurisdiction) =>
                                      jurisdiction === "default"
                                        ? undefined
                                        : jurisdiction,
                                    ),
                                  ),
                                }
                              : binding.Type === "Cloudflare.KVNamespace"
                                ? {
                                    type: "kv_namespace",
                                    name: bindingName,
                                    namespaceId: binding.namespaceId,
                                  }
                                : binding.Type === "Cloudflare.Queue"
                                  ? {
                                      type: "queue",
                                      name: bindingName,
                                      queueName: binding.queueName,
                                    }
                                  : binding.Type === "Cloudflare.AiGateway"
                                    ? {
                                        type: "ai",
                                        name: bindingName,
                                      }
                                    : binding.Type === "Cloudflare.Hyperdrive"
                                      ? {
                                          type: "hyperdrive",
                                          name: bindingName,
                                          id: binding.hyperdriveId,
                                        }
                                      : isWorker(binding)
                                        ? {
                                            type: "service",
                                            name: bindingName,
                                            service: binding.workerName,
                                          }
                                        : // TODO(sam): handle others
                                          undefined;

      if (bindingMeta) {
        yield* resource.bind`${bindingName}`({
          bindings: [bindingMeta],
          hyperdrives: isHyperdrive(binding)
            ? getHyperdriveDevOrigin(binding)
            : undefined,
        });
      } else {
        return yield* Effect.die(`Unknown binding type: ${bindingName}`);
      }
    }
  }
});

export const getCronBindings = (
  bindings: ReadonlyArray<ResourceBinding<Worker["Binding"]>>,
) => Array.from(new Set(bindings.flatMap((b) => b.data.crons ?? [])));
