import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "coolify",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.CoolifyAuth,
  ),
});
