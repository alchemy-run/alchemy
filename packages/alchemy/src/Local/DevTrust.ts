import { delimiter } from "node:path";
import { DEV_TRUST_ENV, trustedCertificates } from "@alchemy.run/node-utils/trust";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Contributions from "../Contributions.ts";

export { DEV_TRUST_ENV };

/**
 * Sets {@link DEV_TRUST_ENV} on this process to the CA files providers
 * contribute (see {@link Contributions.devTrust}), so everything this process
 * spawns inherits it. Set even when no file exists yet: providers can create
 * theirs during the first apply, and readers look each time they start.
 */
export const publish = Effect.fn("DevTrust.publish")(function* () {
  const files = yield* Contributions.devTrust().pipe(
    Effect.catchTag("ContributionError", (error) =>
      Effect.logWarning(error.message).pipe(Effect.as([] as ReadonlyArray<string>)),
    ),
  );
  yield* Effect.sync(() => {
    process.env[DEV_TRUST_ENV] = files.join(delimiter);
  });
  return files;
});

const writeBundle = Effect.fn("DevTrust.writeBundle")(function* (
  certificates: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-dev-trust-" });
  const bundle = path.join(directory, "ca.pem");
  yield* fs.writeFileString(bundle, `${certificates.join("\n")}\n`);
  return bundle;
});

/**
 * The environment for a Node or Bun process started during `alchemy dev`.
 *
 * Node reads `NODE_EXTRA_CA_CERTS` once, at startup, and takes one file, so
 * this writes every CA trusted at this moment (the caller's own and each
 * provider's, see {@link publish}) to a bundle and names it. The bundle is
 * removed when the scope closes: call this in the child's own scope.
 *
 * Empty outside `alchemy dev`, and while no provider's CA exists yet: the
 * caller's own already reaches the process, and Node warns about an empty or
 * missing file on every start. Spread it before a command's own `env`, which
 * wins.
 */
export const nodeEnv = Effect.fn("DevTrust.nodeEnv")(function* () {
  // The process's own variables, not `Config`: they are what a child inherits
  // (a `.env` file's NODE_EXTRA_CA_CERTS never reaches it), as with the trace
  // parent and the log format.
  const trust = yield* Effect.sync(() => process.env[DEV_TRUST_ENV]);
  if (!trust) return {};
  // Without a provider's CA there is nothing to add to the caller's, which the
  // process inherits as it is.
  const contributed = yield* Effect.sync(() => trustedCertificates({ [DEV_TRUST_ENV]: trust }));
  if (contributed.length === 0) return {};
  const certificates = yield* Effect.sync(() => trustedCertificates());
  // Trust is best effort: a child without the bundle is better than no child.
  return yield* writeBundle(certificates).pipe(
    Effect.map((bundle): Record<string, string> => ({ NODE_EXTRA_CA_CERTS: bundle })),
    Effect.catch((error) =>
      Effect.logWarning(`Could not write the dev trust bundle: ${error.message}`).pipe(
        Effect.as<Record<string, string>>({}),
      ),
    ),
  );
});
