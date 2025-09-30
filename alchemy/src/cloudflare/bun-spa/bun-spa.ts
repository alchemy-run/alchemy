import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Assets } from "../assets.ts";
import type { Bindings } from "../bindings.ts";
import {
  spreadBuildProps,
  spreadDevProps,
  Website,
  type WebsiteProps,
} from "../website.ts";
import { Scope } from "../../scope.ts";
import type { Worker } from "../worker.ts";
import { isSecret } from "../../secret.ts";

export interface BunSPAProps<B extends Bindings> extends WebsiteProps<B> {
  frontend: string;
  outDir?: string;
}

export type BunSPA<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

export async function BunSPA<B extends Bindings>(
  id: string,
  props: BunSPAProps<B>,
): Promise<BunSPA<B>> {
  const frontendPath = path.resolve(props.frontend);
  if (!existsSync(frontendPath) || !statSync(frontendPath).isFile()) {
    throw new Error(`Frontend path ${frontendPath} does not exist`);
  }
  const outDir = path.resolve(props.outDir ?? "dist/client");

  if (props.assets) {
    throw new Error("assets are not supported in BunSPA");
  }

  console.log("creating website", outDir);
  const website = await Website(id, {
    spa: true,
    ...props,
    assets: {
      directory: path.resolve(outDir),
    },
    build: spreadBuildProps(
      props,
      `bun build '${frontendPath}' --outdir ${outDir}`,
    ),
  });

  // in dev
  const scope = Scope.current;
  if (scope.local) {
    const cwd = props.cwd ?? process.cwd();
    const dev = spreadDevProps(
      props,
      `bun '${path.relative(cwd, frontendPath)}'`,
    );
    console.log("backend url", website.url);
    const secrets = props.wrangler?.secrets ?? !props.wrangler?.path;
    const env = {
      ...(process.env ?? {}),
      ...(props.env ?? {}),
      ...Object.fromEntries(
        Object.entries(props.bindings ?? {}).flatMap(([key, value]) => {
          if (typeof value === "string" || (isSecret(value) && secrets)) {
            return [[key, value]];
          }
          return [];
        }),
      ),
    };
    website.url = await scope.spawn(website.name, {
      cmd: typeof dev === "string" ? dev : dev.command,
      cwd,
      extract: (line) => {
        const URL_REGEX =
          /http:\/\/(localhost|0\.0\.0\.0|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+\/?/;
        const match = line
          .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
          .match(URL_REGEX);
        if (match) {
          return match[0];
        }
      },
      env: {
        ...Object.fromEntries(
          Object.entries(env ?? {}).flatMap(([key, value]) => {
            if (isSecret(value)) {
              return [[key, value.unencrypted]];
            }
            if (typeof value === "string") {
              return [[key, value]];
            }
            return [];
          }),
        ),
        ...(typeof dev === "object" ? dev.env : {}),
        FORCE_COLOR: "1",
        ...process.env,
        NODE_ENV: "development",
        ALCHEMY_ROOT: Scope.current.rootDir,
        PUBLIC_BACKEND_URL: website.url!,
      },
    });
  }
  return website;
}
