import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "entire",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.EntireAuth,
  ),
});
