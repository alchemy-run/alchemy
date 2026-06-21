import * as Cloudflare from "@/Cloudflare";
import * as Layer from "effect/Layer";

export class Storage extends Cloudflare.R2Bucket<Storage>()("Storage") {}

export const StorageLive = Layer.effect(
  Storage,
  Storage.make({
    storageClass: "Standard",
  }),
);
