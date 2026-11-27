import { isNonInteractive } from "alchemy/Util/interactive";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveUserHome } from "portless";
import {
  ProxyTrustFailed,
  ProxyTrustNotEstablished,
  ProxyTrustToolMissing,
  ProxyUnsupportedPlatform,
} from "../Errors.ts";
import * as Host from "./Host.ts";
import { outputOf, run } from "./Run.ts";

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

export interface TrustInput {
  /** The Node.js binary that runs Portless. */
  readonly node: string;
  /** Portless's CLI. */
  readonly cli: string;
  readonly stateDirectory: string;
  /** The CA Portless signs its certificates with. */
  readonly certificateAuthority: string;
}

/**
 * The step that makes this machine and its browsers trust the Portless CA. It
 * asks the operating system for permission, so the tests replace it with
 * {@link TrustNone}; nothing else about the proxy is faked.
 */
export interface TrustService {
  /** Fails before anything changes when this machine can't be set up. */
  readonly preflight: Effect.Effect<
    void,
    ProxyTrustToolMissing | ProxyUnsupportedPlatform,
    Services
  >;
  /**
   * Checks whether the CA is trusted and, only when it isn't, runs
   * `portless trust` (one OS prompt per machine), then checks again.
   */
  readonly ensure: (
    input: TrustInput,
  ) => Effect.Effect<void, ProxyTrustFailed | ProxyTrustNotEstablished, Services>;
}

/** What a missing `certutil` or an unsupported OS stops a Linux or macOS setup with. */
const preflight: TrustService["preflight"] = Effect.gen(function* () {
  if (Host.platform === "darwin") return;
  if (Host.platform !== "linux") {
    return yield* new ProxyUnsupportedPlatform({ platform: Host.platform });
  }
  const certutil = yield* run(ChildProcess.make("which", ["certutil"])).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );
  if (!certutil) return yield* new ProxyTrustToolMissing({ tool: "certutil" });
});

/**
 * Whether the operating system trusts the CA, without prompting. macOS asks
 * `security`; Linux asks OpenSSL, which reads the distribution's CA store.
 */
const isTrusted = (certificateAuthority: string) =>
  (Host.platform === "darwin"
    ? run(
        ChildProcess.make("security", [
          "verify-cert",
          "-c",
          certificateAuthority,
          "-L",
          "-p",
          "ssl",
        ]),
      )
    : run(ChildProcess.make("openssl", ["verify", certificateAuthority]))
  ).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );

/** The nickname Portless's CA has in the NSS database Chromium reads on Linux. */
const NSS_NICKNAME = "portless-ca";

const certutil = Effect.fn(function* (
  args: ReadonlyArray<string>,
  options: { readonly acceptFailure?: boolean } = {},
) {
  const result = yield* run(ChildProcess.make("certutil", args)).pipe(
    Effect.mapError(
      (cause) =>
        new ProxyTrustFailed({
          command: `certutil ${args.join(" ")}`,
          exitCode: -1,
          output: String(cause),
        }),
    ),
  );
  if (result.exitCode !== 0 && options.acceptFailure !== true) {
    return yield* new ProxyTrustFailed({
      command: `certutil ${args.join(" ")}`,
      exitCode: result.exitCode,
      output: outputOf(result),
    });
  }
  return result;
});

/**
 * Makes Chromium trust the CA on Linux, which reads the user's NSS database
 * rather than the system store. The CA already there is left alone.
 */
const trustInChromium = Effect.fn(function* (certificateAuthority: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const database = `sql:${path.join(resolveUserHome(), ".pki", "nssdb")}`;
  const pem = yield* fs.readFileString(certificateAuthority).pipe(
    Effect.mapError(
      (cause) =>
        new ProxyTrustFailed({
          command: `read ${certificateAuthority}`,
          exitCode: -1,
          output: String(cause),
        }),
    ),
  );
  // PEM line wrapping isn't identity: `certutil -a` and ca.pem wrap differently.
  const identity = (text: string) => text.replace(/\s/g, "");

  yield* fs.makeDirectory(path.join(resolveUserHome(), ".pki", "nssdb"), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ProxyTrustFailed({
          command: "mkdir -p ~/.pki/nssdb",
          exitCode: -1,
          output: String(cause),
        }),
    ),
  );
  const listing = yield* certutil(["-L", "-d", database], { acceptFailure: true });
  if (listing.exitCode !== 0) {
    // A fresh user has no database until a browser or this step makes one.
    yield* certutil(["-N", "-d", database, "--empty-password"]);
  } else {
    const current = yield* certutil(["-L", "-d", database, "-n", NSS_NICKNAME, "-a"], {
      acceptFailure: true,
    });
    if (current.exitCode === 0 && identity(current.stdout) === identity(pem)) return;
  }
  // A missing nickname and a stale one converge on the same path.
  yield* certutil(["-D", "-d", database, "-n", NSS_NICKNAME], { acceptFailure: true });
  // `C,,` marks a CA trusted for TLS server certificates, which is what Chromium needs.
  yield* certutil([
    "-A",
    "-d",
    database,
    "-t",
    "C,,",
    "-n",
    NSS_NICKNAME,
    "-i",
    certificateAuthority,
  ]);
  yield* certutil(["-L", "-d", database, "-n", NSS_NICKNAME]);
});

const ensure: TrustService["ensure"] = Effect.fn(function* (input: TrustInput) {
  if (!(yield* isTrusted(input.certificateAuthority))) {
    const result = yield* run(
      ChildProcess.make(input.node, [input.cli, "trust"], {
        env: { PORTLESS_STATE_DIR: input.stateDirectory },
        extendEnv: true,
        // `trust` may ask for sudo or Keychain access: keep the terminal it can prompt on.
        detached: false,
        stdin: isNonInteractive() ? "ignore" : "inherit",
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProxyTrustFailed({ command: "portless trust", exitCode: -1, output: String(cause) }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* new ProxyTrustFailed({
        command: "portless trust",
        exitCode: result.exitCode,
        output: outputOf(result),
      });
    }
    if (!(yield* isTrusted(input.certificateAuthority))) {
      return yield* new ProxyTrustNotEstablished({
        certificateAuthority: input.certificateAuthority,
      });
    }
  }
  if (Host.platform === "linux") yield* trustInChromium(input.certificateAuthority);
});

/** Trusts the CA through the operating system, and Chromium's NSS database on Linux. */
export const TrustLive: TrustService = { preflight, ensure };

/** Trusts nothing and prompts for nothing: for tests that run their own proxy. */
export const TrustNone: TrustService = { preflight: Effect.void, ensure: () => Effect.void };

/**
 * The trust step in use. Alchemy's own live implementation unless a layer
 * provides another, which is how the tests keep OS prompts out.
 */
export const Trust = Context.Reference<TrustService>("@alchemy.run/portless/Trust", {
  defaultValue: () => TrustLive,
});

/** A layer that swaps the trust step out: `TrustNone` for tests, say. */
export const layer = (service: TrustService) => Layer.succeed(Trust, service);
