import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
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

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL/Yy38fq56JD+xf1K+OMIJNawYl7wLaQOOpiFe/+Y5k";

const credentialUser = /credential for \[([^\]]+)\]/i;

const probeAccess = () =>
  oslogin.getLoginProfileUsers({ name: "users/me" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", (error) => {
      const match = credentialUser.exec(error.message);
      if (match?.[1] === undefined) {
        return Effect.succeed(error._tag);
      }
      return oslogin.getLoginProfileUsers({ name: `users/${match[1]}` }).pipe(
        Effect.as("ok" as const),
        Effect.catchTag(["Forbidden", "NotFound"], (retry) =>
          Effect.succeed(retry._tag),
        ),
      );
    }),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error._tag)),
  );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetUsersSshPublicKey round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const sshKey = yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
            key: KEY,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* sshKey.name;
              const getKey = yield* GCP.Oslogin.GetUsersSshPublicKey(sshKey);
              return Effect.fn(function* () {
                return { metadata: yield* getKey({}) };
              });
            }),
          );
          const probe = yield* Probe({});
          return { sshKey, metadata: probe.metadata };
        }),
      );

      expect(out.metadata?.name).toEqual(out.sshKey.name);
      expect(out.metadata?.fingerprint).toEqual(out.sshKey.fingerprint);
      expect(out.metadata?.key).toContain("[alchemy ");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000, exclusive: true },
);
