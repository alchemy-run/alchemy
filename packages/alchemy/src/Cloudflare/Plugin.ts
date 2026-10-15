import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "cloudflare",
  auth: Plugin.lazy(
    () => import("./Auth/AuthProvider.ts"),
    (module) => module.CloudflareAuth,
  ),
  stateStore: {
    description: "State-store Worker in the profile's Cloudflare account",
    load: Plugin.lazy(
      () => import("./Alchemist/StateStore.ts"),
      (module) => module.stateStore,
    ),
  },
  cli: {
    provider: {
      description: "Manage Cloudflare provider prerequisites",
      load: Plugin.lazy(
        () => import("./Cli.ts"),
        (module) => module.cloudflareCommand,
      ),
    },
  },
});
