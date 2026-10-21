import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // Bootstrap modules are source inputs to the deployment bundler.
  exports: { generate: true, sourceOnly: ["./Bootstrap/*"] },
  steps: [exec("tsc", "-b")],
});
