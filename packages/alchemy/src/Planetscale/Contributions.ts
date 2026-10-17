import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "planetscale",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.PlanetscaleAuth,
  ),
});
