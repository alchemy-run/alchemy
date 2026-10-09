import * as Context from "effect/Context";
import type * as Cloudflare from "@/Cloudflare";

export const NativeImages = Context.Reference<
  Record<string, Cloudflare.Containers.ContainerImageProps>
>("NativeImages", {
  defaultValue: () => ({ shell: { image: "alpine:3.21" } }),
});
