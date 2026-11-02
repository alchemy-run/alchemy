import { makeStackitTarget } from "../core/StackitServe.ts";
import { makeNodeTarget } from "./node.ts";

/** React Router's Node handler on a STACKIT Function behind the CDN. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeStackitTarget(makeNodeTarget(config));
export default target;
