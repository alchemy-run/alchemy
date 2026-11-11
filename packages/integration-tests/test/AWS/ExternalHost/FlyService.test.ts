import * as AWS from "@alchemy.run/aws";
import * as Fly from "@alchemy.run/fly";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { flyApi } from "../../Fly/limit.ts";
import FlyHostService, { FlyBucket } from "./fixtures/fly-service.ts";

const providers = Layer.mergeAll(AWS.providers(), Fly.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  limit: flyApi,
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AwsFlyHostStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const service = yield* FlyHostService;
    const bucket = yield* FlyBucket;
    return {
      url: service.url.as<string>(),
      appName: service.appName,
      orgSlug: service.orgSlug,
      bucketName: bucket.bucketName,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

type Body = { ok: boolean; result?: any; error?: string };

// A fresh fly.dev address and the Role's trust take a while to propagate:
// retry until the route answers `ok`, then report the last answer so a real
// failure shows its AWS error.
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("20 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 30 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe(
  "AWS bindings on a Fly Service",
  { tags: ["provider:aws", "provider:fly", "live"] },
  () => {
    test.provider(
      "S3 PutObject + GetObject with a Fly OIDC token",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* call("/s3?key=fly-roundtrip");
          expectOk(body);
          expect(body.result.contentLength).toBe("from-fly".length);

          const { bucketName } = yield* stack;
          const object = yield* s3.getObject({ Bucket: bucketName!, Key: "fly-roundtrip" });
          expect(object.ContentLength).toBe("from-fly".length);
        }),
      { timeout: 180_000 },
    );

    test.provider(
      "the Service holds no AWS key, and its Role trusts only its App's Fly tokens",
      (_stack) =>
        Effect.gen(function* () {
          const body = yield* call("/identity");
          expectOk(body);
          expect(body.result.hasAccessKey).toBe(false);

          const { appName, orgSlug } = yield* stack;
          const roleName = (body.result.roleArn as string).split("/").pop()!;
          const { Role } = yield* iam.getRole({ RoleName: roleName });
          const trust = JSON.parse(decodeURIComponent(Role.AssumeRolePolicyDocument!));
          const [statement] = [trust.Statement].flat();
          expect(statement.Principal.Federated).toMatch(
            new RegExp(`:oidc-provider/oidc\\.fly\\.io/${orgSlug}$`),
          );
          expect(statement.Condition).toEqual({
            StringEquals: { [`oidc.fly.io/${orgSlug}:aud`]: "sts.amazonaws.com" },
            StringLike: { [`oidc.fly.io/${orgSlug}:sub`]: `${orgSlug}:${appName}:*` },
          });
        }),
      { timeout: 180_000 },
    );
  },
);
