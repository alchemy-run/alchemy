import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "starburst-galaxy",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.StarburstGalaxyAuth,
  ),
});
