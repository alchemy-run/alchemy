import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "doppler",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.DopplerAuth,
  ),
});
