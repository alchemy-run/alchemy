import * as Layer from "effect/Layer";
import { WriteIssues } from "./WriteIssues.ts";
import {
  makeForgejoHttpBinding,
  makeForgejoWriteIssuesClient,
} from "./RuntimeHttp.ts";

/**
 * Issue writes over HTTP with an automatically provisioned restricted token.
 * Works with any Alchemy runtime host.
 *
 * @layer
 * @provides Forgejo.WriteIssues
 */
export const WriteIssuesHttp = Layer.effect(
  WriteIssues,
  makeForgejoHttpBinding({
    scope: "write:issue",
    capability: WriteIssues.key,
    makeClient: makeForgejoWriteIssuesClient,
  }),
);
