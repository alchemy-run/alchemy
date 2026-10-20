import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "gcp",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GcpAuth,
  ),
});
