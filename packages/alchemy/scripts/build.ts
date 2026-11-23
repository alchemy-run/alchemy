import { build, typescript } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  exports: {},
  thirdPartyLicenses: true,
  readme: true,
  steps: [typescript("-b")],
});
