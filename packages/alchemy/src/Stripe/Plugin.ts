import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "stripe",
  auth: () => import("./AuthProvider.ts").then((module) => module.StripeAuth),
});
