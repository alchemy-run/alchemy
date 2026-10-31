import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * One PEM file holding the Portless CA and every certificate in the file the
 * caller's own `NODE_EXTRA_CA_CERTS` names, in a temporary directory that goes
 * with the enclosing scope. Node reads that variable once, at startup, from a
 * single file, so a child that must trust both gets them merged.
 *
 * Temporary: `alchemy/Local/DevTrust` does this for every provider's CA at
 * once, and replaces this module.
 */
export const mergedBundle = Effect.fn(function* (certificateAuthority: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const caller = yield* Config.String("NODE_EXTRA_CA_CERTS").pipe(Config.option);
  const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));

  const texts = [
    yield* read(certificateAuthority),
    ...(Option.isSome(caller) && caller.value !== "" ? [yield* read(caller.value)] : []),
  ];
  // A certificate counts once, however the PEM wraps its lines.
  const certificates = new Map<string, string>();
  for (const text of texts) {
    for (const certificate of text.match(CERTIFICATE) ?? []) {
      certificates.set(certificate.replace(/\s/g, ""), certificate);
    }
  }

  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-portless-" });
  const file = path.join(directory, "ca-bundle.pem");
  yield* fs.writeFileString(file, `${[...certificates.values()].join("\n")}\n`);
  return file;
});
