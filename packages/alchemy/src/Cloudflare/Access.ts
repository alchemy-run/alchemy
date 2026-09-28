import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { UserFacingError } from "../UserFacingError.ts";

export class AccessError extends Schema.TaggedError<AccessError>()(
  "AccessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

export class Access extends Context.Service<
  Access,
  {
    /**
     * Whether requests to `domain` are intercepted by Cloudflare Access.
     * The answer is cached per domain; pass `refresh` to probe again (e.g.
     * right after an Access application was created).
     */
    readonly usesAccess: (
      domain: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<boolean>;
    /**
     * Headers that authenticate a request to `domain` through Cloudflare
     * Access, or `{}` when the domain is not behind Access. Uses the
     * `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`
     * service token when set, otherwise a user token from `cloudflared`.
     */
    readonly getAccessHeaders: (
      domain: string,
    ) => Effect.Effect<Record<string, string>, AccessError>;
  }
>()("alchemy/Cloudflare/Access") {}

/**
 * `true` when a response to an unauthenticated request is Cloudflare Access
 * redirecting to its login page.
 *
 * @internal exported for unit testing.
 */
export const isAccessChallenge = (response: {
  readonly status: number;
  readonly location: string | null;
}): boolean =>
  response.status >= 300 &&
  response.status < 400 &&
  (response.location?.includes(".cloudflareaccess.com/") ?? false);

/**
 * Extract the application token `cloudflared` prints. The token is a JWT, so
 * match the first three-segment base64url string rather than depending on the
 * surrounding wording, which differs between `access token` and
 * `access login` and across cloudflared versions.
 *
 * @internal exported for unit testing.
 */
export const parseCloudflaredToken = (stdout: string): string | undefined =>
  stdout.match(/\b(eyJ[\w-]*\.[\w-]+\.[\w-]+)\b/)?.[1];

const INSTALL_CLOUDFLARED =
  "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/, " +
  "or set CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET to use a service token.";

export const AccessLive = Layer.effect(
  Access,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const detected = new Map<string, boolean>();
    const userTokens = new Map<string, string>();

    const probe = (domain: string) =>
      Effect.promise((signal) =>
        fetch(`https://${domain}`, { redirect: "manual", signal }),
      ).pipe(
        Effect.map((response) =>
          isAccessChallenge({
            status: response.status,
            location: response.headers.get("location"),
          }),
        ),
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.succeed(false)),
      );

    const usesAccess = (
      domain: string,
      options?: { readonly refresh?: boolean },
    ) =>
      Effect.gen(function* () {
        const cached = detected.get(domain);
        if (cached !== undefined && !options?.refresh) return cached;
        const result = yield* probe(domain);
        detected.set(domain, result);
        return result;
      });

    /** Run `cloudflared` and return its stdout; stderr goes to the terminal
     * so the user sees the login URL if the browser does not open. */
    const cloudflared = (args: ReadonlyArray<string>) =>
      ChildProcess.make("cloudflared", [...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          child.stdout.pipe(Stream.decodeText, Stream.mkString),
        ),
        Effect.scoped,
        Effect.mapError(
          (error) =>
            new AccessError({
              message: `Failed to run \`cloudflared\`. ${INSTALL_CLOUDFLARED}`,
              cause: error,
            }),
        ),
      );

    const userToken = (domain: string) =>
      Effect.gen(function* () {
        const cached = userTokens.get(domain);
        if (cached) return cached;
        const app = `https://${domain}`;
        // A still-valid token is printed without opening a browser.
        const existing = parseCloudflaredToken(
          yield* cloudflared(["access", "token", `-app=${app}`]).pipe(
            Effect.catch(() => Effect.succeed("")),
          ),
        );
        const token =
          existing ??
          parseCloudflaredToken(yield* cloudflared(["access", "login", app]));
        if (!token) {
          return yield* new AccessError({
            message: `Failed to log in to Cloudflare Access for ${domain}.`,
          });
        }
        userTokens.set(domain, token);
        return token;
      });

    const getEnv = (name: string) =>
      Config.String(name).pipe(
        Effect.catchTag("ConfigError", () => Effect.succeed(undefined)),
      );

    return Access.of({
      usesAccess,
      getAccessHeaders: Effect.fn(function* (domain) {
        if (!(yield* usesAccess(domain))) {
          return {};
        }
        const clientId = yield* getEnv("CLOUDFLARE_ACCESS_CLIENT_ID");
        const clientSecret = yield* getEnv("CLOUDFLARE_ACCESS_CLIENT_SECRET");
        if (clientId && clientSecret) {
          return {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          } as Record<string, string>;
        }

        if (clientId !== undefined || clientSecret !== undefined) {
          yield* Effect.logWarning(
            "Both CLOUDFLARE_ACCESS_CLIENT_ID and CLOUDFLARE_ACCESS_CLIENT_SECRET must be set to use Access Service Token authentication. " +
              `Only ${
                clientId !== undefined
                  ? "CLOUDFLARE_ACCESS_CLIENT_ID"
                  : "CLOUDFLARE_ACCESS_CLIENT_SECRET"
              } was found.`,
          );
        }

        const token = yield* userToken(domain);
        return { "cf-access-token": token } as Record<string, string>;
      }),
    });
  }),
);
