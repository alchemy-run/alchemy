import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "digitalocean",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.DigitalOceanAuth,
  ),
});
