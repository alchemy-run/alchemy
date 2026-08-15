import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import { Function, type FunctionProps } from "../Functions/Function.ts";
import type { Providers } from "../Providers.ts";
import { makeVercelOutputSite, resolveWebsiteProps } from "./internal.ts";

export interface AstroProps extends Omit<
  FunctionProps,
  "main" | "script" | "prebuilt" | "source" | "build"
> {
  /**
   * Astro project root (the directory containing `astro.config.*`).
   * Defaults to the process working directory.
   */
  rootDir?: string;
  /**
   * Build command run in {@link rootDir}.
   * @default "bunx astro build"
   */
  command?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest lockfile) is hashed — make sure `dist` and `.vercel` are
   * gitignored so build output doesn't churn the hash.
   */
  memo?: MemoOptions | boolean;
}

/**
 * An [Astro](https://astro.build) site deployed to Vercel.
 *
 * `Astro` runs the project's own build; the
 * [`@astrojs/vercel`](https://docs.astro.build/en/guides/integrations-guide/vercel/)
 * adapter (which must be installed and declared in the project's
 * `astro.config.*`) emits a complete `.vercel/output` (Build Output v3)
 * tree — server-rendered pages as serverless functions, prerendered pages
 * and client assets as static files. The tree is deployed by the same
 * engine as every `Vercel.Function`.
 *
 * ```sh
 * bunx astro add vercel   # installs + configures the adapter
 * ```
 *
 * Input files are content-hashed (respecting `.gitignore`) so unchanged
 * projects skip the build and deploy entirely.
 *
 * @resource
 * @product Website
 *
 * @section Deploying an Astro Site
 * @example Basic Astro site
 * ```typescript
 * const site = yield* Vercel.Website.Astro("Site", {
 *   rootDir: "./web",
 * });
 * ```
 *
 * @section Class Form
 * @example Declaring a site class
 * ```typescript
 * class Site extends Vercel.Website.Astro<Site>()("Site", {
 *   rootDir: "./web",
 * }) {}
 *
 * const site = yield* Site;
 * ```
 */
export const Astro: {
  <Self>(): <Req = never>(
    id: string,
    props?:
      | InputProps<AstroProps>
      | Effect.Effect<InputProps<AstroProps>, never, Req>,
  ) => Effect.Effect<Self, never, Req | Providers> & {
    new (_: never): Function;
  };
  <Req = never>(
    id: string,
    props?:
      | InputProps<AstroProps>
      | Effect.Effect<InputProps<AstroProps>, never, Req>,
  ): Effect.Effect<Function, never, Req | Providers>;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(makeAstro(id, propsEff))
    : makeAstro(id, propsEff)) as any;

const makeAstro = (id: string, propsEff: any) =>
  Effect.gen(function* () {
    const props = yield* resolveWebsiteProps(propsEff);
    return yield* makeVercelOutputSite({
      id,
      props,
      defaultCommand: "bunx astro build",
    });
  });
