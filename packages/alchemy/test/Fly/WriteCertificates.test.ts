import * as ACME from "@/ACME";
import * as Fly from "@/Fly";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Acme from "@distilled.cloud/acme";
import * as acme from "@distilled.cloud/acme/acme";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { dockerAvailable, startPebble, stopPebble } from "../ACME/Pebble.ts";
import CertificatesApi, {
  CertIp,
  CertSite,
} from "./fixtures/certificates-api.ts";

/**
 * Runtime certificate management on a Fly App: `request` a Fly-managed
 * certificate, `upload` a PEM issued elsewhere (here: Pebble in Docker,
 * so no public CA is involved), `check`, `get`, `remove`.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
});

const Stack = Alchemy.Stack(
  "FlyWriteCertificatesFixture",
  { providers: Fly.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const site = yield* CertSite;
    yield* CertIp;
    const api = yield* CertificatesApi;
    return { appName: site.appName, url: api.url };
  }),
);

const SUITE = "fly";
const pebble = beforeAll(startPebble(SUITE, { acme: 14300, management: 8300 }));
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
afterAll(stopPebble(SUITE));

const UPLOAD_HOST = "alchemy-wc-upload.alchemy-test-2.us";
const REQUEST_HOST = "alchemy-wc-request.alchemy-test-2.us";

interface Reply {
  ok: boolean;
  value?: any;
  error?: string;
}

/** Issue a certificate for `hostname` from Pebble, in-process. */
const issueFromPebble = (env: {
  ca: ACME.CertificateAuthority;
  solver: ACME.DnsSolverDescriptor;
}) =>
  Effect.gen(function* () {
    const accountKey = yield* Acme.Jose.generateAccountKey();
    const account = yield* acme
      .newAccount({ termsOfServiceAgreed: true })
      .pipe(Effect.provide(ACME.accountLayer({ ca: env.ca, accountKey })));
    const solver = yield* ACME.resolveDnsSolver(env.solver);
    return yield* ACME.issueCertificate({
      identifiers: [UPLOAD_HOST],
      solver,
    }).pipe(
      Effect.provide(
        ACME.accountLayer({
          ca: env.ca,
          accountKey,
          accountUrl: account.location,
        }),
      ),
    );
  });

test.skipIf(!dockerAvailable)(
  "uploads, inspects and removes a custom certificate, and requests a Fly-managed one",
  Effect.gen(function* () {
    const env = yield* pebble;
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const call = (path: string, body?: unknown) =>
      Effect.gen(function* () {
        const request =
          body === undefined
            ? HttpClientRequest.get(`${url}${path}`)
            : HttpClientRequest.post(`${url}${path}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body),
              );
        const response = yield* client.execute(request);
        const text = yield* response.text;
        return JSON.parse(text || "null") as Reply;
      });

    const health = yield* call("/health").pipe(
      Effect.retry({
        schedule: Schedule.exponential("1 second"),
        times: 12,
      }),
    );
    expect(health.ok).toBe(true);

    // Start clean: leftovers from an interrupted run.
    yield* call(`/remove?hostname=${UPLOAD_HOST}`);
    yield* call(`/remove?hostname=${REQUEST_HOST}`);

    const issued = yield* issueFromPebble(env);
    const uploaded = yield* call("/upload", {
      hostname: UPLOAD_HOST,
      fullchain: issued.chain,
      privateKey: Redacted.value(issued.privateKey),
    });
    expect(uploaded.error).toBeUndefined();
    expect(uploaded.ok).toBe(true);
    expect(uploaded.value?.hostname).toBe(UPLOAD_HOST);

    const fetched = yield* call(`/get?hostname=${UPLOAD_HOST}`);
    expect(fetched.ok).toBe(true);
    expect(fetched.value?.hostname).toBe(UPLOAD_HOST);
    expect(
      (fetched.value?.certificates ?? []).some(
        (c: { source?: string }) => c.source === "custom",
      ),
    ).toBe(true);

    // Re-upload replaces in place (conflict → delete + create).
    const reuploaded = yield* call("/upload", {
      hostname: UPLOAD_HOST,
      fullchain: issued.chain,
      privateKey: Redacted.value(issued.privateKey),
    });
    expect(reuploaded.ok).toBe(true);

    const checked = yield* call(`/check?hostname=${UPLOAD_HOST}`);
    expect(checked.ok).toBe(true);
    expect(checked.value?.hostname).toBe(UPLOAD_HOST);

    const requested = yield* call(`/request?hostname=${REQUEST_HOST}`);
    expect(requested.ok).toBe(true);
    const requestedDetail = yield* call(`/get?hostname=${REQUEST_HOST}`);
    expect(requestedDetail.value?.acme_requested).toBe(true);
    expect(requestedDetail.value?.dns_requirements).toBeDefined();

    const removed = yield* call(`/remove?hostname=${UPLOAD_HOST}`);
    expect(removed.ok).toBe(true);
    yield* call(`/remove?hostname=${REQUEST_HOST}`);
    const gone = yield* call(`/get?hostname=${UPLOAD_HOST}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (reply) => reply.value === null,
        times: 10,
      }),
    );
    expect(gone.value).toBeNull();
    // Removing again is a no-op.
    expect((yield* call(`/remove?hostname=${UPLOAD_HOST}`)).ok).toBe(true);
  }),
  { timeout: 240_000 },
);
