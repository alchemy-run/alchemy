import path from "node:path";
import type { Assets } from "./assets.ts";
import type { Bindings } from "./bindings.ts";
import { Website, type WebsiteProps } from "./website.ts";
import type { Worker } from "./worker.ts";

export interface ViteProps<B extends Bindings>
  extends Omit<WebsiteProps<B>, "spa"> {}

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
    spa: true,
    assets:
      typeof props.assets === "object"
        ? {
            ...props.assets,
            dist: props.assets.dist ?? defaultAssets,
          }
        : (props.assets ?? defaultAssets),
  });
}
