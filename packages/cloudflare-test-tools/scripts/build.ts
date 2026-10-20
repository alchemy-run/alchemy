import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  steps: [exec("tsc", "-p", "tsconfig.json")],
});
