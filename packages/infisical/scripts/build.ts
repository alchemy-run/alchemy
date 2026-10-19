import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: { worker: true },
  steps: [exec("tsc", "-b")],
});
