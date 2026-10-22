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
 * Deploy a Next.js application to Azure App Service: `next build`
 * then a long-running `next({ dev: false })` Node.js process on a Linux App Service web app (no Docker).
 * Does **not** use OpenNext (those wrappers are Lambda/workerd).
 *
 * The `.next` output (and `public/` when present) is zip-deployed with
 * the server. `next`, `react`, and `react-dom` are installed by App
 * Service's remote build rather than bundled.
 *
 * During `alchemy dev` the site is `next dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live deployment.
 *
 *
 * ### Creating Next.js Sites
 * **Example:** Basic Next.js App
 * ```typescript
 * const site = yield* Azure.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
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
