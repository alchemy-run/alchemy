import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "1password",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.OnePasswordAuth,
  ),
});
