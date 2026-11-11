import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "e2b",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.E2BAuth,
  ),
});
