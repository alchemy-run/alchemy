import * as Azure from "@alchemy.run/azure";
import { ServerHost } from "alchemy/Runtime/Process";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { PUBLIC_KEY_1 } from "../helpers.ts";
import { distilledFromSource } from "./distilled-source.ts";
import { PROGRAM_LOCATION, PROGRAM_VM_SIZE, programNetwork } from "./program-network.ts";

/** Storage the Effect VM's blob binding reads and writes. */
export const VmData = Azure.Storage.StorageAccount("VmData", { location: PROGRAM_LOCATION });
export const VmFiles = Effect.gen(function* () {
  const account = yield* VmData;
  return yield* Azure.Storage.BlobContainer("VmFiles", {
    storageAccount: account.storageAccountName,
  });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native VM program: `fetch` with a `Config` env value, a blob
 * binding exercised with the VM's managed identity, and a `ServerHost` loop.
 */
export default class EffectVm extends Azure.Compute.VirtualMachine<EffectVm>()(
  "EffectVm",
  Effect.gen(function* () {
    const { nic } = yield* programNetwork("Effect");
    return {
      main: import.meta.url,
      // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
      build: { input: { plugins: [distilledFromSource] } },
      location: PROGRAM_LOCATION,
      vmSize: PROGRAM_VM_SIZE,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [PUBLIC_KEY_1],
      env: {
        GREETING: Config.String("AZURE_VM_EFFECT_GREETING").pipe(Config.withDefault("hello")),
      },
    };
  }),
  Effect.gen(function* () {
    const filesContainer = yield* VmFiles;
    const files = yield* Azure.Storage.BlobContainerReadWrite(filesContainer);

    // A background loop next to the HTTP server.
    const ticks = yield* Ref.make(0);
    const host = yield* ServerHost;
    yield* host.run(
      Ref.update(ticks, (n) => n + 1).pipe(
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return text(`${process.env.GREETING ?? "missing"} from a vm`);
          case "/ticks":
            return text(String(yield* Ref.get(ticks)));
          case "/blob":
            return yield* respond(
              Effect.gen(function* () {
                const value = url.searchParams.get("value") ?? "";
                yield* files.put(key, value, { contentType: "text/plain" });
                const blob = yield* files.get(key);
                return { text: blob?.text() };
              }),
            );
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}
