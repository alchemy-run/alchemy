import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { KVNamespace } from "./KVNamespace.ts";
import { NamespaceBinding } from "./KVNamespaceBinding.ts";

export class Get extends Binding.Service<
  Get,
  (
    namespace: KVNamespace,
  ) => Effect.Effect<(key: string) => Effect.Effect<string | null>>
>()("Cloudflare.KV.Get") {}

export const GetLive = Layer.effect(
  Get,
  Effect.gen(function* () {
    const Policy = yield* GetPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (namespace: KVNamespace) {
      yield* Policy(namespace);
      const kvNamespace = (env as Record<string, runtime.KVNamespace>)[
        namespace.LogicalId
      ];

      return Effect.fn(function* (key: string) {
        return yield* Effect.promise(() => kvNamespace.get(key));
      });
    });
  }),
);

export class GetPolicy extends Binding.Policy<
  GetPolicy,
  (namespace: KVNamespace) => Effect.Effect<void>
>()("Cloudflare.KV.Get") {}

export const GetPolicyLive = GetPolicy.layer.succeed(NamespaceBinding);
