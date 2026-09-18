import * as Layer from "effect/Layer";
import { ReadIssues } from "./ReadIssues.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoReadIssuesClient,
} from "./RuntimeHttp.ts";

/**
 * Issue reads over HTTP with an automatically provisioned restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.ReadIssues
 */
export const ReadIssuesHttp = Layer.effect(
  ReadIssues,
  makeForgejoHttpBinding({
    scope: "read:issue",
    capability: ReadIssues.key,
    makeClient: makeForgejoReadIssuesClient,
  }),
);
