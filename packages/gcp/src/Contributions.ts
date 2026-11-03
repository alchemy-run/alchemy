import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "gcp",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GcpAuth,
  ),
  stateStores: {
    gcp: {
      description: "Cloud Storage state store in the profile's GCP project",
      options: {
        name: { description: "A store other than the project's default, by name" },
      },
      load: Contributions.lazy(
        () => import("./StateStore/Lifecycle.ts"),
        (module) => module.stateStore,
      ),
    },
  },
});
