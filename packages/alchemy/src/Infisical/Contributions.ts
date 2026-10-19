import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "infisical",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.InfisicalAuth,
  ),
});
