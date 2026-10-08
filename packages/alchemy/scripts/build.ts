import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // Bootstrap modules are source inputs to the deployment bundler.
  exports: { sourceOnly: ["./Runtime/Bootstrap/*"] },
  thirdPartyLicenses: true,
  readme: true,
  steps: [exec("tsc", "-b")],
});
