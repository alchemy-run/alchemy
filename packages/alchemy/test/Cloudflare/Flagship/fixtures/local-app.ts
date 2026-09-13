import * as Cloudflare from "alchemy/Cloudflare";
export const App = Cloudflare.Flagship.App("OfflineFlags", {
  name: "offline-flags-fixture",
});
