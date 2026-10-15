import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "axiom",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AxiomAuth,
  ),
});
