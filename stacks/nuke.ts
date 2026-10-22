import * as AWS from "@alchemy.run/aws";
import * as Azure from "@alchemy.run/azure";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Fly from "@alchemy.run/fly";
import * as Hetzner from "@alchemy.run/hetzner";
import * as Neon from "@alchemy.run/neon";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Prisma from "@alchemy.run/prisma";
import * as Railway from "@alchemy.run/railway";
import * as Stripe from "@alchemy.run/stripe";
import * as Turso from "@alchemy.run/turso";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "Nuke",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      AWS.providers(),
      Azure.providers(),
      Hetzner.providers(),
      Fly.providers(),
      Railway.providers(),
      Neon.providers(),
      Planetscale.providers(),
      // Prisma credentials resolve at layer build like Neon/Planetscale:
      // set PRISMA_SERVICE_TOKEN (with CI=1) or configure the profile.
      Prisma.providers(),
      Stripe.providers(),
      Turso.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {}),
);
