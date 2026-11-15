import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { cloudflareSkipReason, UnreadableLake } from "../fixtures/bindings.ts";
import { getJson } from "../fixtures/http.ts";
import GalaxySchemaDiscoveryWorker from "../fixtures/schema-discovery-worker.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Cloudflare.providers()),
});

const named = (title: string) =>
  cloudflareSkipReason ? `${title} [skipped: ${cloudflareSkipReason}]` : title;

type Outcome = { ok: true; count?: number } | { ok: false; tag: string; message: string };

// A discovery that runs needs a bucket Galaxy can read and a Location
// privilege on the API client's role. This suite drives every binding from
// a Worker against a lake Galaxy cannot read: Galaxy refuses the run with
// NO_PRIVILEGE_TO_ACCESS_LOCATION, lists none, and refuses an ID it never issued.
test.provider.skipIf(!!cloudflareSkipReason)(
  named("a Worker drives the SchemaDiscovery bindings against a lake Galaxy cannot read"),
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* UnreadableLake;
          const worker = yield* GalaxySchemaDiscoveryWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      const body = yield* getJson<{
        created: Outcome;
        listed: Outcome;
        got: Outcome;
        applied: Outcome;
        deleted: Outcome;
      }>(url, "/discover");
      expect(body.created).toMatchObject({ ok: false, tag: "BadRequest" });
      expect(body.created.ok === false && body.created.message).toContain(
        "NO_PRIVILEGE_TO_ACCESS_LOCATION",
      );
      expect(body.listed).toEqual({ ok: true, count: 0 });
      // Galaxy checks an ID's form before looking it up.
      for (const refused of [body.got, body.applied, body.deleted]) {
        expect(refused).toMatchObject({
          ok: false,
          tag: "BadRequest",
          message: "Invalid id: sd-1234567890",
        });
      }

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:schema-discovery",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 600_000,
  },
);
