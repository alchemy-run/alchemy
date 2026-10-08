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

// Image publication and Cloud Run rollout exceed the per-test budget.
// Contributors provide fixture origins and own their deployments and cleanup.
layer(NodeServices.layer, { excludeTestServices: true })("GCP Foldkit rendering modes", (it) => {
  for (const mode of foldkitModes) {
    const origin = process.env[`FOLDKIT_GCP_${mode.toUpperCase()}_URL`];
    for (const check of foldkitChecks) {
      it.effect.skipIf(!origin || !!process.env.FAST || (check === "browser" && !browserEnabled))(
        `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"}`,
        () =>
          Effect.gen(function* () {
            yield* verifyFoldkitRendering(origin!, mode);
            if (check === "browser") yield* verifyFoldkitBrowser(origin!, mode);
          }),
        { tags: ["provider:gcp", "provider:gcp:website", "live", check], timeout: 120_000 },
      );
    }
  }
});
