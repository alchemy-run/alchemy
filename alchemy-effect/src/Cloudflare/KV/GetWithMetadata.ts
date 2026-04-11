import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { KVNamespace } from "./KVNamespace.ts";
import { NamespaceBinding } from "./KVNamespaceBinding.ts";

export interface GetWithMetadataOptions extends runtime.KVNamespaceGetOptions<undefined> {}

export class GetWithMetadata extends Binding.Service<
  GetWithMetadata,
  (
    namespace: KVNamespace,
  ) => Effect.Effect<
    <Metadata = unknown>(
      key: string,
      options?: GetWithMetadataOptions,
    ) => Effect.Effect<
      runtime.KVNamespaceGetWithMetadataResult<string, Metadata>
    >
  >
>()("Cloudflare.KV.GetWithMetadata") {}

export const GetWithMetadataLive = Layer.effect(
  GetWithMetadata,
  Effect.gen(function* () {
    const Policy = yield* GetWithMetadataPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (namespace: KVNamespace) {
      yield* Policy(namespace);
      const kvNamespace = (env as Record<string, runtime.KVNamespace>)[
        namespace.LogicalId
      ];

      return <Metadata = unknown>(
        key: string,
        options?: GetWithMetadataOptions,
      ) =>
        Effect.promise(() =>
          kvNamespace.getWithMetadata<Metadata>(key, options),
        );
    });
  }),
);

export class GetWithMetadataPolicy extends Binding.Policy<
  GetWithMetadataPolicy,
  (namespace: KVNamespace) => Effect.Effect<void>
>()("Cloudflare.KV.GetWithMetadata") {}

export const GetWithMetadataPolicyLive =
  GetWithMetadataPolicy.layer.succeed(NamespaceBinding);
