import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "HetznerWebsiteViteExample",
  {
    providers: Hetzner.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    // `alchemy deploy` runs `vite build` and serves `dist/` from a
    // Hetzner.Service on an auto-created cx22 in fsn1.
    // `alchemy dev` is Vite's own dev server (HMR included) and creates
    // no Server or Service.
    const site = yield* Hetzner.Website.Vite("Web", {
      memo: {
        include: ["index.html", "src/**", "package.json", "vite.config.ts"],
      },
    });

    return {
      url: site.url,
      serverId: site.server?.serverId,
      ipv4: site.server?.ipv4,
    };
  }),
);
