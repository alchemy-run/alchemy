import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "railway",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.RailwayAuth,
  ),
});
