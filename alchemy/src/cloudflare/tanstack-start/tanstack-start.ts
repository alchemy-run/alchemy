import type { Assets } from "../assets.ts";
import type { Bindings } from "../bindings.ts";
import { Vite, type ViteProps } from "../vite/vite.ts";
import type { Worker } from "../worker.ts";

export interface TanStackStartProps<B extends Bindings> extends ViteProps<B> {}

// don't allow the ASSETS to be overriden
export type TanStackStart<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function TanStackStart<B extends Bindings>(
  id: string,
  props?: Partial<TanStackStartProps<B>>,
): Promise<TanStackStart<B>> {
  return await Vite(id, {
    entrypoint: "dist/server/index.js",
    assets: "dist/client",
    compatibility: "node",
    noBundle: true,
    spa: false,
    ...props,
    wrangler: {
      ...props?.wrangler,
      transform: (spec) => {
        const transformed = props?.wrangler?.transform?.(spec) ?? spec;
        return {
          ...transformed,
          main: props?.wrangler?.main ?? "@tanstack/react-start/server-entry",
        };
      },
    },
  });
}
