import path from "node:path";
import { getPackageManagerRunner } from "../../util/detect-package-manager.ts";
import { logger } from "../../util/logger.ts";
import type { Assets } from "../assets.ts";
import type { Bindings } from "../bindings.ts";
import { Vite, type ViteProps } from "../vite/vite.ts";
import type { Worker } from "../worker.ts";

export interface ReactRouterProps<B extends Bindings> extends ViteProps<B> {
  /**
   * @default workers/app.ts
   */
  main?: string;
}

// don't allow the ASSETS to be overriden
export type ReactRouter<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function ReactRouter<B extends Bindings>(
  id: string,
  props: ReactRouterProps<B> = {},
): Promise<ReactRouter<B>> {
  const runner = await getPackageManagerRunner();
  const cwd = path.resolve(props.cwd ?? process.cwd());
  const ssr = await detectSSREnabled(cwd);
  return await Vite(id, {
    ...props,
    build:
      props.build ??
      `${runner} react-router typegen && ${runner} react-router build`,
    dev:
      props.dev ??
      `${runner} react-router typegen && ${runner} react-router dev`,
    spa: !ssr,
    compatibility: "node",
    entrypoint: props.entrypoint ?? (ssr ? "build/server/index.js" : undefined),
    noBundle: props.noBundle ?? true,
    assets: props.assets ?? "build/client",
    wrangler: {
      main:
        props.wrangler?.main ??
        props.main ??
        (ssr ? "workers/app.ts" : undefined),
      transform: props.wrangler?.transform,
    },
  });
}

/**
 * Detect if SSR is enabled by checking for an `ssr` property in `react-router.config.ts`.
 * If no config is found or if there is no `ssr` property, default to true in line with React Router's default behavior.
 * @see https://reactrouter.com/api/framework-conventions/react-router.config.ts
 */
async function detectSSREnabled(cwd: string): Promise<boolean> {
  const candidates = [
    "react-router.config.mjs",
    "react-router.config.js",
    "react-router.config.ts",
    "react-router.config.mts",
  ];
  try {
    const config = await Promise.any(
      candidates.map((candidate) => import(path.join(cwd, candidate))),
    );
    if (
      typeof config.default === "object" &&
      config.default &&
      "ssr" in config.default &&
      typeof config.default.ssr === "boolean"
    ) {
      return config.default.ssr;
    }
    return true;
  } catch {
    logger.warn(
      "[ReactRouter] No react-router.config.{ts,js,mts,mjs} found, assuming SSR is enabled",
    );
    return true;
  }
}
