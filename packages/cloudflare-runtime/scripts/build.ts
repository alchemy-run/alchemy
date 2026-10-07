import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  thirdPartyLicenses: true,
  stamp: "dist",
  steps: [
    // tsdown resolves distilled from its compiled `lib/`.
    exec("tsc", "-b", "../../submodules/distilled/packages/cloudflare/tsconfig.json"),
    exec("tsdown"),
  ],
});
