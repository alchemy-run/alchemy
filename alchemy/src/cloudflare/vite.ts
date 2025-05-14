import path from "node:path";
import type { Assets } from "./assets.js";
import type { Bindings } from "./bindings.js";
import { Website, type WebsiteProps } from "./website.js";
import type { Worker } from "./worker.js";

export interface ViteProps<B extends Bindings> extends WebsiteProps<B> {}

// don't allow the ASSETS to be overriden
export type Vite<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function Vite<B extends Bindings>(
  id: string,
  props: ViteProps<B>,
): Promise<Vite<B>> {
  const defaultAssets = path.join("dist", "client");
  return Website(id, {
    ...props,
    assets:
      typeof props.assets === "object"
        ? {
            dist: props.assets.dist ?? defaultAssets,
          }
        : (props.assets ?? defaultAssets),
  });
}
