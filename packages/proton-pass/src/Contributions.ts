import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "proton-pass",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.ProtonPassAuth,
  ),
});
