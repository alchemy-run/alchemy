import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import type { To } from "../../policy.ts";
import { Worker } from "../worker/worker.ts";
import type { Namespace, NamespaceProps } from "./namespace.ts";

export interface Bind<B = Namespace<string, NamespaceProps>>
  extends Capability<"Cloudflare.KV.Namespace.Bind", B> {}

export const Bind = Binding<
  <B extends Namespace<string, NamespaceProps>>(
    namespace: B,
  ) => Binding<Worker, Bind<To<B>>>
>(Worker, "Cloudflare.KV.Namespace.Bind");

export const bindFromWorker = () =>
  Bind.provider.succeed({
    attach: ({ source }) => ({
      bindings: [
        {
          type: "kv_namespace",
          name: source.id,
          namespace_id: source.attr.namespaceId,
        },
      ],
    }),
  });
