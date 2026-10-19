import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "fly",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.FlyAuth,
  ),
});
