import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "slack",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.SlackAuth,
  ),
});
