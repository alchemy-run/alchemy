import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  browserEnabled,
  foldkitChecks,
  foldkitModes,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/FoldkitRendering.ts";

// CloudFront provisioning exceeds the test timeout budget. Contributors prepare
// these fixture deployments separately; this suite never owns or deletes them.
layer(NodeServices.layer, { excludeTestServices: true })("AWS Foldkit rendering modes", (it) => {
  for (const mode of [...foldkitModes, "static"] as const) {
    const origin = process.env[`FOLDKIT_AWS_${mode.toUpperCase()}_URL`];
    for (const check of foldkitChecks) {
      it.effect.skipIf(!origin || !!process.env.FAST || (check === "browser" && !browserEnabled))(
        `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"}`,
        () =>
          Effect.gen(function* () {
            yield* verifyFoldkitRendering(origin!, mode);
            if (check === "browser") yield* verifyFoldkitBrowser(origin!, mode);
          }),
        {
          tags: ["provider:aws", "provider:aws:website", "live", check],
          timeout: 120_000,
        },
      );
    }
  }
});
