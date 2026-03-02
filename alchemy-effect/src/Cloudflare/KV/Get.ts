import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceBinding } from "./NamespaceBinding.ts";

export class Get extends Binding.Service<
  Get,
  (
    namespace: Namespace,
  ) => Effect.Effect<(key: string) => Effect.Effect<string | null>>
>()("Cloudflare.KV.Get") {}

export const GetLive = Layer.effect(
  Get,
  Effect.gen(function* () {
    const Policy = yield* GetPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (namespace: Namespace) {
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
  (namespace: Namespace) => Effect.Effect<void>
>()("Cloudflare.KV.Get") {}

export const GetPolicyLive = Layer.effect(GetPolicy, NamespaceBinding);
