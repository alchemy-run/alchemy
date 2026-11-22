import * as Archil from "@alchemy.run/archil";
import * as Binding from "alchemy/Binding";
import type { MountCapability } from "alchemy/Mount";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

export const PROBE_MARKER = "installed by a mount capability";

/**
 * A stand-in for a filesystem client another provider's mount binding
 * installs (a bucket FUSE client, say): one install line and a FUSE
 * requirement.
 */
const probeCapability: MountCapability = {
  id: "alchemy-probe",
  install: [`RUN echo '${PROBE_MARKER}' > /etc/alchemy-probe`],
  requires: { fuse: true },
};

const bindProbe = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (!host) return;
  // `Binding.Host` is a bare `ResourceLike`; mount-capable hosts accept `mounts`.
  yield* (host as unknown as { bind: (sid: string, data: object) => Effect.Effect<void> }).bind(
    "AlchemyProbe",
    { mounts: [probeCapability] },
  );
});

/**
 * A program sandbox whose binding installs a client, so Alchemy builds a
 * derived image (its base plus the install line), pushes it to the
 * repository the test configures, and boots the sandbox from it.
 */
export default class DerivedApi extends Archil.Sandbox<DerivedApi>()(
  "DerivedApi",
  Effect.gen(function* () {
    const repository = yield* Config.String("ARCHIL_PUSH_REPOSITORY").pipe(Config.withDefault(""));
    const server = yield* Config.String("ARCHIL_PUSH_SERVER").pipe(Config.withDefault(""));
    const password = yield* Config.Redacted("ARCHIL_PUSH_PASSWORD").pipe(
      Config.withDefault(Redacted.make("")),
    );
    return {
      main: import.meta.url,
      port: 3000,
      idleTtlSeconds: 300,
      push: { repository, credentials: { server, username: "AWS", password } },
    };
  }),
  Effect.gen(function* () {
    yield* bindProbe;
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: fs.readFileString("/etc/alchemy-probe").pipe(
        Effect.map((text) => HttpServerResponse.text(text.trim())),
        Effect.catch((e) => Effect.succeed(HttpServerResponse.text(String(e), { status: 500 }))),
      ),
    };
  }),
) {}
