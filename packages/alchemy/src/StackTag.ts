/**
 * The `Stack` service tag as an import-graph LEAF.
 *
 * `Stack.ts` is an engine module — its static closure reaches the auth
 * providers, the CLI, and `Util/Node.ts` (`node:net`). Runtime bridges
 * that only need to `Layer.succeed` the Stack service (`Serve/Bridge.ts`,
 * `AWS/Lambda/WebsiteHandlers.ts`) are compiled by foreign bundlers
 * (Next/turbopack, nitro rollup) into server bundles that may run on
 * workerd, where a `node:*` external at module scope is a hard 500 on
 * every request. They import THIS module instead; `Stack.ts` builds its
 * public callable over the same tag, so service identity is shared.
 */

import * as Context from "effect/Context";
import type { Stack, StackSpec } from "./Stack.ts";

/** The underlying Context tag for the {@link Stack} service. */
export const StackTag = Context.Service<Stack, Omit<StackSpec, "output">>()(
  "Stack",
);
