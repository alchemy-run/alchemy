import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "anthropic",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AnthropicAuth,
  ),
});
