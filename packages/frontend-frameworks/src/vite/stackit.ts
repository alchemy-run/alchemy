import { makeStackitTarget } from "../core/StackitServe.ts";
import { makeNodeTarget } from "./node.ts";

/**
 * A plain Vite build for STACKIT. The site is assets-only: `Stackit.Website.Vite`
 * uploads the client directory to a bucket and skips the serve entry, which runs
 * only with `origin: "function"`.
 */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeStackitTarget(makeNodeTarget(config));
export default target;
