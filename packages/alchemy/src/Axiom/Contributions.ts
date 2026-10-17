import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "axiom",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.AxiomAuth,
  ),
});
