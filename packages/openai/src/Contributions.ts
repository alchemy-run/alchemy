import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "openai",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.OpenAIAuth,
  ),
});
