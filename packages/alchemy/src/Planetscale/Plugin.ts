import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "planetscale",
  auth: () => import("./AuthProvider.ts").then((module) => module.PlanetscaleAuth),
});
