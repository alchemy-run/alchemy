import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "discord",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.DiscordAuth,
  ),
});
