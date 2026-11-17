import * as Contributions from "alchemy/Contributions";
import * as Flag from "effect/cli/Flag";

export default Contributions.make({
  name: "cloudflare",
  auth: Contributions.lazy(
    () => import("./Auth/AuthProvider.ts"),
    (module) => module.CloudflareAuth,
  ),
  stateStores: {
    cloudflare: {
      description: "State-store Worker in the profile's Cloudflare account",
      flags: {
        name: Flag.String("name").pipe(
          Flag.withDescription("The store's full Worker name, for a store other than the default"),
        ),
        domain: Flag.String("domain").pipe(
          Flag.withDescription("Hostname the store is served on, when it has a custom domain"),
        ),
      },
      load: Contributions.lazy(
        () => import("./Alchemist/StateStore.ts"),
        (module) => module.stateStore,
      ),
    },
  },
  cli: {
    provider: {
      description: "Manage Cloudflare provider prerequisites",
      load: Contributions.lazy(
        () => import("./Cli.ts"),
        (module) => module.cloudflareCommand,
      ),
    },
  },
});
