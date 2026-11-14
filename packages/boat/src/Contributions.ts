import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "boat",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.BoatAuth,
  ),
});
