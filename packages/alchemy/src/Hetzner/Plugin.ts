import * as Plugin from "../Plugin.ts";

export default Plugin.make({
  name: "hetzner",
  auth: () => import("./AuthProvider.ts").then((module) => module.HetznerAuth),
});
