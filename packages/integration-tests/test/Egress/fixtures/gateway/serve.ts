import * as GitHub from "@alchemy.run/github";
import * as Egress from "alchemy/Egress";
import * as Effect from "effect/Effect";
import { ECHO_HEADER, ECHO_HOST, ECHO_VALUE, READ_REPO, TestGateway } from "./gateway.ts";

/** {@link TestGateway}'s implementation: read-only GitHub with the profile token, and an echo host. */
export const serveTestGateway = TestGateway.serve(
  Effect.gen(function* () {
    return {
      repo: yield* GitHub.Egress({
        token: GitHub.ProfileToken,
        repositories: [{ repository: READ_REPO, contents: "read" }],
      }),
      echo: yield* Egress.Http({
        credential: {
          host: ECHO_HOST,
          paths: ["/anything/**"],
          headers: { [ECHO_HEADER]: ECHO_VALUE },
        },
      }),
    };
  }),
);
