import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "openrouter",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.OpenRouterAuth,
  ),
});
