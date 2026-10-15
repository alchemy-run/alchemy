import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "cloudflare",
  auth: () => import("./Auth/AuthProvider.ts").then((module) => module.CloudflareAuth),
  stateStores: {
    cloudflare: {
      description: "State-store Worker in the profile's Cloudflare account",
      layer: () => import("./StateStore/State.ts").then((module) => module.state()),
    },
  },
  cli: {
    provider: () => import("./Cli.ts").then((module) => module.cloudflareCommand),
  },
});
