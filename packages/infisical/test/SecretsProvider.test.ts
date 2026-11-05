import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import { downloadSecrets } from "../src/SecretsProvider.ts";

const projectId = "6f1c0b52-6a8f-4f3e-9a51-0d6c1a2f7e10";

const secret = (key: string, value: string, type: "shared" | "personal") => ({
  id: `${key}-${type}`,
  _id: `${key}-${type}`,
  workspace: projectId,
  environment: "dev",
  version: 1,
  type,
  secretKey: key,
  secretValue: value,
  secretComment: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  secretValueHidden: false,
});

/**
 * Infisical's v4 list endpoint, for a user who has a personal override of
 * DEVELOPER_NAME, shared both directly and through an import. The server
 * drops personal secrets unless `includePersonalOverrides` is set, and with
 * it returns one secret per key, the personal one first in priority.
 */
const infisicalForUser = HttpClient.make((request) =>
  Effect.sync(() => {
    const url = new URL(request.url);
    const personal = url.searchParams.get("includePersonalOverrides") === "true";
    const resolve = (shared: string, own: string) =>
      personal
        ? secret("DEVELOPER_NAME", own, "personal")
        : secret("DEVELOPER_NAME", shared, "shared");
    return HttpClientResponse.fromWeb(
      request,
      Response.json({
        secrets: [resolve("shared", "jason"), secret("REGION", "us-east", "shared")],
        imports: [
          {
            secretPath: "/",
            environment: "dev",
            folderId: "imported",
            secrets: [{ ...resolve("imported", "jason-imported"), secretKey: "IMPORTED_NAME" }],
          },
        ],
      }),
    );
  }),
);

test("a user's personal overrides replace the shared values", async () => {
  const env = await Effect.runPromise(
    downloadSecrets(
      { project: projectId, environment: "dev" },
      { token: Redacted.make("user-token"), apiBaseUrl: "https://infisical.test" },
    ).pipe(Effect.provideService(HttpClient.HttpClient, infisicalForUser)),
  );
  expect(env).toEqual({
    IMPORTED_NAME: "jason-imported",
    DEVELOPER_NAME: "jason",
    REGION: "us-east",
  });
});
