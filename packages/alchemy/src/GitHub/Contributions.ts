import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "github",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GitHubAuth,
  ),
});
