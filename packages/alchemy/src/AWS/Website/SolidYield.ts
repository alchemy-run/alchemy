import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite } from "./FrameworkSite.ts";
import {
  VITE_AWS_TARGET_SPECIFIER,
  VITE_FRAMEWORK_SPECIFIER,
  viteFrameworkOptions,
  type ViteProps,
} from "./Vite.ts";

/**
 * Props for {@link SolidYield}. A solid-yield app is a plain Vite project,
 * so the surface is {@link ViteProps} — `rootDir`, `vite`, `domain`, `spa`,
 * `errorPage`, and the rest of the shared website props.
 */
export interface SolidYieldProps extends ViteProps {}

/**
 * Deploy a [solid-yield](https://github.com/devagrawal09/solid-yield) app to
 * AWS: the client build in S3 behind a CloudFront distribution. solid-yield
 * writes Solid 2 components as typed generator functions, and its apps are
 * client-rendered Vite projects — so the deployment is assets-only and never
 * creates a server function.
 *
 * The `vite-plugin-solid-yield` and `@solidjs/vite-plugin` plugins live in
 * your project's own `vite.config.*`, which loads natively. The build runs
 * through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/aws` deploy target — the package
 * must be installed in your project. Input files are content-hashed so
 * unchanged projects skip the build and deploy entirely.
 *
 * solid-yield apps render on the client, so `spa` defaults on: unmatched
 * paths serve `index.html` with a `200` and the app's router resolves the
 * route once it boots.
 *
 * During `alchemy dev` the site is Vite's own dev server — Solid's HMR
 * works unchanged — and no AWS resources are created. `Alchemy.remote()`
 * opts back into the full deployment.
 *
 * ### Creating solid-yield Sites
 * **Example:** Basic solid-yield App
 * ```typescript
 * const site = yield* AWS.Website.SolidYield("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* AWS.Website.SolidYield("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.SolidYield("Web", {
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Deep Links
 * A deep link like `/todos/42` arrives at the edge as a request for a file
 * that does not exist. `spa` is on by default so the shell is served
 * instead of a 404. An app that ships a real 404 page opts out with
 * `errorPage` — the two are mutually exclusive.
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* AWS.Website.SolidYield("Web", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Build Configuration
 * Vite configuration (the solid-yield and Solid plugins included) lives in
 * your project's own `vite.config.*`. The `vite` bag holds deploy-time
 * overrides merged over that file, and `config` selects an alternate
 * config file.
 *
 * **Example:** Deploy-Time Base Path Override
 * ```typescript
 * const site = yield* AWS.Website.SolidYield("Web", {
 *   vite: { base: "/app/" },
 * });
 * ```
 *
 * @resource
 */
export const SolidYield = (id: string, props: InputProps<SolidYieldProps> = {}) => {
  const p = props as SolidYieldProps;
  return makeFrameworkSite(id, props, {
    name: "SolidYield",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_AWS_TARGET_SPECIFIER,
    options: viteFrameworkOptions(p),
    // solid-yield apps are client-rendered: the whole deployable output is
    // the client build, so the deploy never creates a server function. `spa`
    // defaults on, but yields to an explicit `errorPage` (the two are
    // mutually exclusive downstream).
    static: {
      spa: p.spa ?? (p.errorPage === undefined ? true : undefined),
      errorPage: p.errorPage,
    },
  }).pipe(Namespace.push(id));
};
