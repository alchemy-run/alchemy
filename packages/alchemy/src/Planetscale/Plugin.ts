import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "planetscale",
  auth: Plugin.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.PlanetscaleAuth,
  ),
});
