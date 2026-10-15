import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "stripe",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.StripeAuth,
  ),
});
