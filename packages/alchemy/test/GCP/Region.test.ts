import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Region from "@distilled.cloud/gcp/Region";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: GCP.providers().pipe(
    Layer.provideMerge(GCP.Region.of("us-east4")),
  ),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test(
  "regional endpoint routing",
  Effect.sync(() => {
    const base = "https://secretmanager.googleapis.com/";
    expect(
      Region.endpointFor(
        base,
        "v1/projects/p/locations/us-east1/secrets/s",
        "required",
      ),
    ).toEqual("https://secretmanager.us-east1.rep.googleapis.com/");
    expect(
      Region.endpointFor(base, "v1/projects/p/secrets/s", "required"),
    ).toEqual(base);
    expect(
      Region.endpointFor(
        "https://run.googleapis.com/",
        "v2/projects/p/locations/us-east1/services/s",
        "required",
      ),
    ).toEqual("https://run.googleapis.com/");
    expect(
      Region.endpointFor(
        "https://run.googleapis.com/",
        "v2/projects/p/locations/us-east1/services/s",
        "prefer",
      ),
    ).toEqual("https://run.us-east1.rep.googleapis.com/");
  }),
);

test.provider.skipIf(!hasGcpCreds)(
  "a stack-level GCP.Region sets the default region; regional secrets reach their endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          // No `location`: placed in the scope's default region.
          const queue = yield* GCP.CloudTasks.Queue("RegionQueue", {});
          // A regional secret, also in the default region.
          const secret = yield* GCP.SecretManager.LocationsSecret(
            "RegionalSecret",
            {},
          );
          return { queue: queue.name, secret: secret.name };
        }),
      );

      expect(out.queue).toContain("/locations/us-east4/");
      expect(out.secret).toContain("/locations/us-east4/");

      // Out-of-band read with plain fetch: distilled routes the regional
      // secret to secretmanager.us-east4.rep.googleapis.com.
      const live = yield* secretmanager.getProjectsLocationsSecrets({
        name: out.secret,
      });
      expect(live.name).toEqual(out.secret);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
