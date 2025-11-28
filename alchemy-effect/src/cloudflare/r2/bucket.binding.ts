import { Binding } from "../../binding.ts";
import type { Capability } from "../../capability.ts";
import type { To } from "../../policy.ts";
import { Worker } from "../worker/worker.ts";
import type { Bucket } from "./bucket.ts";

export interface Bind<B = Bucket>
  extends Capability<"Cloudflare.R2.Bucket.Bind", B> {}

export const Bind = Binding<
  <B extends Bucket>(bucket: B) => Binding<Worker, Bind<To<B>>>
>(Worker, "Cloudflare.R2.Bucket.Bind");

export const bindFromWorker = () =>
  Bind.provider.succeed({
    attach: ({ source }) => ({
      bindings: [
        {
          type: "r2_bucket",
          name: source.id,
          bucket_name: source.attr.name,
          jurisdiction:
            source.attr.jurisdiction === "default"
              ? undefined
              : source.attr.jurisdiction,
        },
      ],
    }),
  });
