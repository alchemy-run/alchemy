import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "axiom",
  auth: () => import("./AuthProvider.ts").then((module) => module.AxiomAuth),
});
