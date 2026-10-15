import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "github",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GitHubAuth,
  ),
});
