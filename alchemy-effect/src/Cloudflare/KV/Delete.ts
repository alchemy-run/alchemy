import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceBinding } from "./NamespaceBinding.ts";

export class Delete extends Binding.Service<
  Delete,
  (namespace: Namespace) => Effect.Effect<(key: string) => Effect.Effect<void>>
>()("Cloudflare.KV.Delete") {}

export const DeleteLive = Layer.effect(
  Delete,
  Effect.gen(function* () {
    const Policy = yield* DeletePolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (namespace: Namespace) {
      yield* Policy(namespace);
      const kvNamespace = (env as Record<string, runtime.KVNamespace>)[
        namespace.LogicalId
      ];

      return Effect.fn(function* (key: string) {
        return yield* Effect.promise(() => kvNamespace.delete(key));
      });
    });
  }),
);

export class DeletePolicy extends Binding.Policy<
  DeletePolicy,
  (namespace: Namespace) => Effect.Effect<void>
>()("Cloudflare.KV.Delete") {}

export const DeletePolicyLive = DeletePolicy.layer.succeed(NamespaceBinding);
