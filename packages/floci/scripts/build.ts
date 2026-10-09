import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: {},
  steps: [exec("tsc", "-b")],
});
