import { getPackageManagerRunner } from "../../util/detect-package-manager.ts";
import type { Assets } from "../assets.ts";
import type { Bindings } from "../bindings.ts";
import { WebsitePlugin, type WebsitePluginProps } from "../website-plugin.ts";
import { Website, type WebsiteProps } from "../website.ts";
import type { Worker } from "../worker.ts";

export interface ViteProps<B extends Bindings>
  extends Omit<WebsiteProps<B>, "spa"> {}

export type Vite<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

const runner = await getPackageManagerRunner();

export async function Vite<B extends Bindings>(
  id: string,
  props: ViteProps<B>,
): Promise<Vite<B>> {
  return await Website(id, {
    ...props,
    spa: true,
    assets:
      typeof props.assets === "string"
        ? { directory: props.assets }
        : {
            ...(props.assets ?? {}),
            directory:
              props.assets?.directory ??
              (props.entrypoint || props.script ? "dist/client" : "dist"),
          },
    build: props.build ?? `${runner} vite build`,
    dev: props.dev ?? `${runner} vite dev`,
  });
}

export type ViteAssetsProps = Partial<WebsitePluginProps>;
export type ViteAssets = WebsitePlugin;

export function ViteAssets(props: ViteAssetsProps = {}): WebsitePlugin {
  return WebsitePlugin({
    not_found_handling: "single-page-application",
    build: props.build ?? `${runner} vite build`,
    dev: props.dev ?? `${runner} vite dev`,
    dist:
      props.dist ??
      ((props) => (props.entrypoint || props.script ? "dist/client" : "dist")),
  });
}
