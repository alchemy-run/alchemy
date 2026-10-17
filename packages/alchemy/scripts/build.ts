import { build, exec } from "../../../scripts/package-build.ts";

build(import.meta.dirname, {
  // Bootstrap modules are source inputs to the deployment bundler.
  exports: {
    sourceOnly: [
      "./Runtime/Bootstrap/*",
      "./AWS/Bootstrap/*",
      "./Cloudflare/Bootstrap/*",
      "./GCP/Bootstrap/*",
      "./Fly/Bootstrap",
      "./Hetzner/Bootstrap",
      "./Prisma/Bootstrap",
      "./Railway/Bootstrap",
    ],
  },
  thirdPartyLicenses: true,
  readme: true,
  steps: [exec("tsc", "-b")],
});
