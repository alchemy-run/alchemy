import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "hetzner",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.HetznerAuth,
  ),
});
