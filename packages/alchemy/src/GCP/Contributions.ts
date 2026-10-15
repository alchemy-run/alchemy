import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "gcp",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GcpAuth,
  ),
});
