import * as Effect from "effect/Effect";
import {
  makeStackitTarget,
  STACKIT_CDN_HOST_SUFFIX,
  writeStackitEntry,
} from "../core/StackitServe.ts";
import { makeNodeTarget, makeVinextServeEntrySource, type VinextNodeTarget } from "./node.ts";

export { make } from "./node.ts";

/**
 * vinext's own production server on a STACKIT Function behind the CDN. It isn't
 * described by `nodeServe`, so the entry is vinext's, with the host and `Cache-Control`
 * handling the other targets get from `behindCdn`.
 */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]): VinextNodeTarget => {
  const node = makeNodeTarget(config);
  return {
    ...makeStackitTarget(node),
    build: (context) =>
      node.build!(context).pipe(
        Effect.flatMap((output) =>
          writeStackitEntry(
            output,
            makeVinextServeEntrySource({
              behindCdn: { forwardedHostSuffix: STACKIT_CDN_HOST_SUFFIX },
            }),
          ),
        ),
      ),
  };
};
export default target;
