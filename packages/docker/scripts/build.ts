import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // The bootstrap is a source input to the deployment bundler.
  exports: { generate: true, sourceOnly: ["./Bootstrap"] },
  steps: [exec("tsc", "-b")],
});
