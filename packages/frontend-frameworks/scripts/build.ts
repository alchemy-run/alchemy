import { build, copy, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  thirdPartyLicenses: true,
  stamp: "dist",
  steps: [
    // tsdown resolves distilled from its compiled `lib/`.
    exec(
      "tsc",
      "-b",
      "../../submodules/distilled/packages/aws/tsconfig.json",
      "../../submodules/distilled/packages/cloudflare/tsconfig.json",
    ),
    exec("tsdown"),
    // tsdown cleans dist/, deleting the declarations while their
    // tsbuildinfo in .cache/ still reports them up to date.
    exec("tsc", "-b", "--force", "tsconfig.json"),
    copy("src/nextjs/runner.mjs", "dist/nextjs/runner.mjs"),
  ],
});
