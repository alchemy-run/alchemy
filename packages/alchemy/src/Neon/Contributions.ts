import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "neon",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.NeonAuth,
  ),
});
