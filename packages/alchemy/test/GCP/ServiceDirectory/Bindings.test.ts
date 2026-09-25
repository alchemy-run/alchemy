import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

test.provider.skipIf(!hasGcpCreds)(
  "Resolve and GetEndpoint on a Service Directory service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* GCP.ServiceDirectory.Namespace("Services", {
            location: "us-central1",
          });
          const service = yield* GCP.ServiceDirectory.Service("Api", {
            namespace: ns.name,
          });
          const endpoint = yield* GCP.ServiceDirectory.Endpoint("Https", {
            service: service.name,
            address: "10.0.0.2",
            port: 443,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* endpoint.name;
              const resolve = yield* GCP.ServiceDirectory.Resolve(service);
              const getEndpoint =
                yield* GCP.ServiceDirectory.GetEndpoint(endpoint);
              return Effect.fn(function* () {
                const resolved = yield* resolve();
                const live = yield* getEndpoint();
                return { resolved, live };
              });
            }),
          );
          return {
            service,
            endpoint,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.resolved.service?.name).toEqual(out.service.name);
      expect(
        (out.probe.resolved.service?.endpoints ?? []).some(
          (item) => item.name === out.endpoint.name,
        ),
      ).toEqual(true);
      expect(out.probe.live.name).toEqual(out.endpoint.name);
      expect(out.probe.live.address).toEqual("10.0.0.2");
      expect(out.probe.live.port).toEqual(443);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
