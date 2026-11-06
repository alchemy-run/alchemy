import * as Archil from "@alchemy.run/archil";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ArchilWebsiteVocsExample",
  {
    providers: Archil.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Archil.Website.Vocs("VocsDocs", {
      memo: {
        include: ["src/**", "public/**", "package.json", "vocs.config.ts"],
      },
    });

    return {
      url: site.url,
    };
  }),
);
