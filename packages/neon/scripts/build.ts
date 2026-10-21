import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { generate: true, worker: true },
  steps: [exec("tsc", "-b")],
});
