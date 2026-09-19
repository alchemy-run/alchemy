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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_PRIVATECA && !process.env.FAST;

test.provider.skipIf(!runLifecycle)(
  "FetchCaCerts and GetCertificateAuthority invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.PrivateCA.CaPool("AppCa", {
            location: "us-central1",
            tier: "DEVOPS",
            publishingOptions: {
              publishCaCert: false,
              publishCrl: false,
            },
          });
          const ca = yield* GCP.PrivateCA.CertificateAuthority("Root", {
            caPool: pool.name,
            type: "SELF_SIGNED",
            keySpec: { algorithm: "RSA_PKCS1_2048_SHA256" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* ca.name;
              const fetchCaCerts = yield* GCP.PrivateCA.FetchCaCerts(pool);
              const getCa = yield* GCP.PrivateCA.GetCertificateAuthority(ca);
              return Effect.fn(function* () {
                const certs = yield* fetchCaCerts();
                const live = yield* getCa();
                return { certs, live };
              });
            }),
          );
          return { ca, probe: yield* Probe({}) };
        }),
      );

      expect(Array.isArray(out.probe.certs.caCerts ?? [])).toEqual(true);
      expect(out.probe.live.name).toEqual(out.ca.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
