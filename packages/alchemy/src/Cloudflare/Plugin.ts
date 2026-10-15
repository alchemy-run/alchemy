import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "cloudflare",
  auth: Plugin.lazy(
    () => import("./Auth/AuthProvider.ts"),
    (module) => module.CloudflareAuth,
  ),
  stateStores: {
    cloudflare: {
      description: "State-store Worker in the profile's Cloudflare account",
      layer: Plugin.lazy(
        () => import("./StateStore/State.ts"),
        (module) =>
          ({ name }) =>
            module.state({ name }),
      ),
      lifecycle: Plugin.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.lifecycle,
      ),
    },
  },
  cli: {
    provider: Plugin.lazy(
      () => import("./Cli.ts"),
      (module) => module.cloudflareCommand,
    ),
  },
});
