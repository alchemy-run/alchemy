import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: {},
  thirdPartyLicenses: true,
  steps: [exec("tsc", "-b")],
});
