import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "archil",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.ArchilAuth,
  ),
});
