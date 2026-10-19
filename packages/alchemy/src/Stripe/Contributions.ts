import * as Contributions from "../Contributions.ts";

export default Contributions.make({
  name: "stripe",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.StripeAuth,
  ),
});
