import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives `next build` plus a Node
 * `next({ dev: false })` serve entry. This module IS the Node pipeline
 * (not OpenNext).
 */
export const NEXTJS_NODE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nextjs/node";

export interface NextjsProps extends FrameworkSiteProps {}

/**
 * Deploy a Next.js application to an Archil sandbox: `next build`
 * then a long-running `next({ dev: false })` program on port 3000.
 * Does **not** use OpenNext (those wrappers are Lambda/workerd).
 *
 * The `.next` output (and `public/` when present) is packed into the
 * program's files. `next`, `react`, and `react-dom` are installed next to the
 * program with `npm install` rather than bundled.
 *
 * During `alchemy dev` the site is `next dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live sandbox.
 *
 *
 * ### Creating Next.js Sites
 * **Example:** Basic Next.js App
 * ```typescript
 * const site = yield* Archil.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Nextjs",
    framework: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    target: NEXTJS_NODE_FRAMEWORK_SPECIFIER,
    skipClientAssets: true,
    install: ["next", "react", "react-dom"],
  }).pipe(Namespace.push(id));
