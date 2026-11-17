import * as Contributions from "alchemy/Contributions";

/**
 * Rivet Cloud sign-in for the alchemy CLI. Only `RivetCloud.ControlPlane`
 * uses it; self-hosted control planes need no Rivet account.
 */
export default Contributions.make({
  name: "rivet",
  auth: Contributions.lazy(
    () => import("./Cloud/AuthProvider.ts"),
    (module) => module.RivetCloudAuth,
  ),
});
