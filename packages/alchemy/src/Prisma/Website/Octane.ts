import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Octane website. */
export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Octane SSR and client assets on Prisma Compute. Select node() from @alchemy.run/frontend-frameworks/octane/node-adapter in the project’s octane.config.ts.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Octane application
 * ```typescript
 * const site = yield* Prisma.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Octane("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   compute: { destroyOldDeployment: true },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/octane",
    target: "@alchemy.run/frontend-frameworks/octane/node",
  }).pipe(Namespace.push(id));
