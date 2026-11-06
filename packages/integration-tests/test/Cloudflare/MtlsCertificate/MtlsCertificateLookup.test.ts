import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as mtls from "@distilled.cloud/cloudflare/mtls-certificates";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails, missingName } from "../../lookup.ts";
import {
  LOOKUP_MANAGED_CA,
  LOOKUP_TARGET_KEY,
  LOOKUP_TARGET_LEAF,
} from "./fixtures/lookup-certs.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:mtlscertificate", "live"];

const script = `export default { async fetch() { return new Response("ok"); } };`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "MtlsCertificateLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const cert = yield* Cloudflare.MtlsCertificate.MtlsCertificate("lookup-target", {
      ca: false,
      certificates: LOOKUP_TARGET_LEAF,
      privateKey: Redacted.make(LOOKUP_TARGET_KEY),
    });
    return {
      mtlsCertificateId: cert.mtlsCertificateId.as<string>(),
      name: cert.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a Worker binds a looked-up certificate, by name and by id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { mtlsCertificateId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.MtlsCertificate.MtlsCertificate.lookup({ name });
        const byId = Cloudflare.MtlsCertificate.MtlsCertificate.lookup({ mtlsCertificateId });
        const worker = yield* Cloudflare.Worker("mtls-lookup-worker", {
          script,
          env: { CERT: byName },
        });
        return {
          workerName: worker.workerName,
          mtlsCertificateId: byName.mtlsCertificateId,
          ca: byId.ca,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.mtlsCertificateId).toBe(mtlsCertificateId);
      expect(out.ca).toBe(false);

      // The Worker's binding names the looked-up certificate.
      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: out.workerName,
      });
      expect(JSON.stringify(settings.bindings)).toContain(mtlsCertificateId);

      // A lookup re-resolves to the same certificate, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["mtls-lookup-worker"].action).toBe("noop");

      // Destroy removes the Worker and leaves the certificate alone.
      yield* stack.destroy();
      const survivor = yield* mtls.getMtlsCertificate({ accountId, mtlsCertificateId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing certificate fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("mtls-lookup-missing", {
            script,
            env: { CERT: Cloudflare.MtlsCertificate.MtlsCertificate.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a certificate this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.MtlsCertificate.MtlsCertificate("lookup-managed", {
          ca: true,
          certificates: LOOKUP_MANAGED_CA,
        });
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("mtls-lookup-managed-worker", {
              script,
              env: { CERT: Cloudflare.MtlsCertificate.MtlsCertificate.lookup({ name: name! }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
