import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:hybridcompute", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/**
 * Fixture identity for pre-registering an Arc machine without an agent:
 * a fixed host ID and a PKCS#1 RSA public key (generated once, no private
 * key kept).
 */
export const fixtureVmId = "3f2c1a9e-5b7d-4e8a-9c21-7d6e5f4a3b2c";
export const fixtureVmId2 = "8d4b6c2a-1e3f-4a5b-9c7d-2e1f0a9b8c7d";
export const fixturePublicKey =
  "MIIBCgKCAQEAqB72SMX+EJZIkpTSteGm7YVERSZMz/iBOpd0xkv3OBzHlJA1E4WbK5+gxu7Xr0boJ9nLvWacOWsxSeBaHggJnjnRGSV/AWt+VY6M8K1FGCqms7W8t3MrjuMuTr3UgLiqRXOY2QpnqPlIX6YDq5/+nsqi7btGHXvsmJ+0qKAv84NyFlS3f6lpgmNUgpAV+NMR95BBdYTGFqwVpIj1fnjXY/LVKYPCnN/6JMGUvSn4BdCbWUCam8Wi2kHVNl0jkdoGFL+Lq72uPydoHs+7N6bheshpPwdX0drvykvdEx3UaZYOApy8l20tZ69yJqPTSqfms+KUStMj30ZhgI2CBVke3wIDAQAB";

/**
 * A connected Linux Arc machine (`<resourceGroup>/<machineName>`) for
 * lifecycles that need a running Connected Machine agent (extensions, run
 * commands). The free-trial subscription has none.
 */
export const connectedMachine = process.env.AZURE_TEST_ARC_MACHINE?.split("/");

/**
 * A connected Windows Server Arc machine (`<resourceGroup>/<machineName>`)
 * for license profile lifecycles.
 */
export const connectedWindowsMachine =
  process.env.AZURE_TEST_ARC_WINDOWS_MACHINE?.split("/");
