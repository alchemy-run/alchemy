import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Test from "alchemy/Test/Bun";
import * as Layer from "effect/Layer";

// #region show
const { test, beforeAll, deploy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers()),
  dev: true,
});
// #endregion show
void [test, beforeAll, deploy];
