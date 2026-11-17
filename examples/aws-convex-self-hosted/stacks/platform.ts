import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex/aws";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * What stages share. Deploy it once per AWS account: stage `prod` to the
 * production account with `CONVEX_DOMAIN=example.com`, and stage `dev` to the
 * development account with `CONVEX_DOMAIN=previews.example.com`.
 */
export class Platform extends Alchemy.Stack<Platform, { convex: Convex.PlatformHandle }>()(
  "ConvexPlatform",
) {}

export default Platform.make(
  { providers: Convex.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const isProd = stage === "prod";
    const convex = yield* Convex.Platform("Convex", {
      domain: yield* Config.String("CONVEX_DOMAIN"),
      // Production runs on Postgres. Previews run on SQLite, so the
      // development platform needs no database server.
      db: isProd ? { engine: "postgres", instanceClass: "db.t4g.micro", storage: 20 } : undefined,
      deletionProtection: isProd,
    });
    return { convex };
  }),
);
