import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { generate: true },
  steps: [exec("tsc", "-b")],
});
