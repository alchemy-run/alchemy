import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "gcp",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.GcpAuth,
  ),
});
