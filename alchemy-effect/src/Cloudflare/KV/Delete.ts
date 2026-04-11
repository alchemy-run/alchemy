import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import type { KVNamespace } from "./KVNamespace.ts";
import { NamespaceBinding } from "./KVNamespaceBinding.ts";

export class Delete extends Binding.Service<
  Delete,
  (
    namespace: KVNamespace,
  ) => Effect.Effect<(key: string) => Effect.Effect<void>>
>()("Cloudflare.KV.Delete") {}

export const DeleteLive = Layer.effect(
  Delete,
  Effect.gen(function* () {
    const Policy = yield* DeletePolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (namespace: KVNamespace) {
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
  (namespace: KVNamespace) => Effect.Effect<void>
>()("Cloudflare.KV.Delete") {}

export const DeletePolicyLive = DeletePolicy.layer.succeed(NamespaceBinding);
