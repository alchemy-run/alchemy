import * as Layer from "effect/Layer";
import { ReadWriteIssues } from "./ReadWriteIssues.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoReadIssuesClient,
  makeForgejoWriteIssuesClient,
} from "./RuntimeHttp.ts";

/**
 * Issue reads and writes over HTTP using one restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.ReadWriteIssues
 */
export const ReadWriteIssuesHttp = Layer.effect(
  ReadWriteIssues,
  makeForgejoHttpBinding({
    scope: "write:issue",
    capability: ReadWriteIssues.key,
    makeClient: (auth) => ({
      ...makeForgejoReadIssuesClient(auth),
      ...makeForgejoWriteIssuesClient(auth),
    }),
  }),
);
