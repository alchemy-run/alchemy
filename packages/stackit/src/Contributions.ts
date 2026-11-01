import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "stackit",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.StackitAuth,
  ),
});
