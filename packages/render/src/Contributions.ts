import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "render",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.RenderAuth,
  ),
});
