import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "fly",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.FlyAuth,
  ),
});
