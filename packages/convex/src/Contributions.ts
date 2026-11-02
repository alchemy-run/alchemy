import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "convex",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.ConvexAuth,
  ),
});
