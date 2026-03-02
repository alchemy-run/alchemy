import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceBinding } from "./NamespaceBinding.ts";

export interface ListOptions extends runtime.KVNamespaceListOptions {}

export class List extends Binding.Service<
  List,
  (
    namespace: Namespace,
  ) => Effect.Effect<
    <Metadata = unknown>(
      options?: ListOptions,
    ) => Effect.Effect<runtime.KVNamespaceListResult<Metadata, string>>
  >
>()("Cloudflare.KV.List") {}

export const ListLive = Layer.effect(
  List,
  Effect.gen(function* () {
    const Policy = yield* ListPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (namespace: Namespace) {
      yield* Policy(namespace);
      const kvNamespace = (env as Record<string, runtime.KVNamespace>)[
        namespace.LogicalId
      ];

      return <Metadata = unknown>(options?: ListOptions) =>
        Effect.promise(() => kvNamespace.list<Metadata>(options));
    });
  }),
);

export class ListPolicy extends Binding.Policy<
  ListPolicy,
  (namespace: Namespace) => Effect.Effect<void>
>()("Cloudflare.KV.List") {}

export const ListPolicyLive = ListPolicy.layer.succeed(NamespaceBinding);
