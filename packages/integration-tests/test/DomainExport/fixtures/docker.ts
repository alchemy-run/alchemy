/**
 * What every DomainExport file shares: pinned images, a scratch stack that
 * deploys a file's containers as Alchemy resources and destroys them when
 * the file ends, the suite shape that deploys them before any test, readiness
 * polls on the real clock, and the tier switch.
 *
 * Tier B (the release run): Postgres, ClickHouse, Trino, the Iceberg REST
 * fixture. Tier C (opt-in, `--tags export-lakes`): every other catalog and
 * the hand-written consumers.
 */
import * as Docker from "@alchemy.run/docker";
import { layer, type LayerMethods, registerHook } from "@alchemy.run/test";
import type * as Core from "@alchemy.run/test/Core";
import * as CoreModule from "@alchemy.run/test/Core";
import type { StackServices } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { findAvailablePort } from "../../Docker/Runtime.ts";

/** Images by version and digest. A held version says why beside it. */
export const images = {
  postgres: "postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f",
  mysql: "mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902",
  clickhouse:
    "clickhouse/clickhouse-server:25.8@sha256:0152dd511befe6a2c2ef53e930726179669b08116da78500b37c51c96ff5ee77",
  trino:
    "trinodb/trino:484@sha256:2704eb53935af5e582d63d6033e9bf99d20c325e9b0e30b1016ef59a4773979f",
  // Older supported versions, run with `--tags export-versions`.
  postgres14: "postgres:14@sha256:834a046089d76edd1d2e81c4741f3ad5d1853646ededc86c2708936aad31c1ed",
  postgres15: "postgres:15@sha256:1aac5b49cefd627f02816141ca4ad012d6cc19460dfe02a9b5168a105be3fc53",
  postgres16: "postgres:16@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657",
  mysql80: "mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b",
  clickhouse253:
    "clickhouse/clickhouse-server:25.3@sha256:b627d7a9bc0e0c1bac26cdbe9d2fc6316faa29c5d8a174f28f5abd57d0fa6ba2",
  trino476:
    "trinodb/trino:476@sha256:00125e40d063bc4816d165482f6044872b18b56026fb959d3b28ce1f96ffbbee",
  minio:
    "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
  // The fixture publishes no version tags; the digest is the pin.
  icebergRestFixture:
    "apache/iceberg-rest-fixture:latest@sha256:009f9f6897cc1e8fd6e8133c401c7a3e7c333c71293a621d06a71570ae989c29",
  lakekeeper:
    "quay.io/lakekeeper/catalog:v0.15.0@sha256:b02a882df48042020c473a79b980a643fcc883a6f9c21b74c5b7cc8eabeec9fe",
  polaris:
    "apache/polaris:1.8.0@sha256:347615e736cab2c9be0d8c464552ac930be4755302bb0aeb745216bbae99ba5b",
  nessie:
    "ghcr.io/projectnessie/nessie:0.110.0@sha256:d3e30c5dda5c57df198f1093f7fe7ef0266f4972a18cf097f447745fcba632f5",
  // 1.3.0 (`latest` until 1.3.1) fails every table create on a Jackson conflict in its S3 file IO.
  gravitino:
    "apache/gravitino-iceberg-rest:1.3.1@sha256:cdcc1b2fb30f2e88c12a8ee08e077f6168cac4938474b7503d9a76cbbfcb3517",
} as const;

/**
 * Tier C's opt-in tag: its tests run only when a run names it
 * (`--tags export-lakes`), never in a run that names nothing.
 */
export const lakesTag = "export-lakes";

/**
 * Shrink steps after a falsification. Each step reruns a sequence against a
 * container, so unbounded shrinking can outlast the case's timeout and turn
 * a real failure into a timeout; a bounded shrink reports the failure itself.
 */
export const dockerShrinks = 20;

/** Every DomainExport test's ceiling. The containers it needs are up before it starts. */
export const testTimeout = 120_000;

/**
 * Deploying a file's containers, before its first test: on a cold machine
 * this pulls their images (Trino's is 2.4 GB), so it is setup, never a
 * test's time.
 */
const setupTimeout = 900_000;

/** Destroying a file's containers, after its last test. */
const teardownTimeout = 300_000;

/**
 * A file's suite over `environment` (its containers and clients): built in
 * a `beforeAll`, so deploying containers and pulling images are setup, then
 * shared by every test through the layer's memo map, and destroyed when the
 * suite ends. A suite whose tests a run does not select builds nothing. The
 * real clock: readiness polls and timeouts must pass time, which the test
 * clock does not.
 */
export const exportSuite = <R, E>(
  environment: Layer.Layer<R, E>,
  name: string,
  body: (it: LayerMethods<R>) => void,
) => {
  const memoMap = Layer.makeMemoMapUnsafe();
  layer(environment, { memoMap, timeout: teardownTimeout, excludeTestServices: true })(
    name,
    (it) => {
      const scope = Scope.makeUnsafe();
      registerHook("beforeAll", {
        body: () => Layer.buildWithMemoMap(environment, memoMap, scope).pipe(Effect.asVoid),
        timeout: setupTimeout,
      });
      registerHook("afterAll", {
        body: () => Scope.close(scope, Exit.void),
        timeout: teardownTimeout,
      });
      body(it);
    },
  );
};

/** Generated sequences per property: `EXPORT_TEST_RUNS`, else the suite's own default. */
export const runsOr = (fallback: number) => {
  const configured = Number(process.env.EXPORT_TEST_RUNS);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
};

export const testOptions = { providers: Docker.providers() };

/** A file's own scratch stack, its state durable under `.alchemy/state`. */
export const fixtureStack = (name: string, file: string) =>
  CoreModule.scratchStack(testOptions, name, file);

/** `NO_DESTROY=1` keeps a run's resources for inspection, as the other suites do. */
const keepResources = !!process.env.NO_DESTROY;

/**
 * Deploy `program` for the rest of the scope, then destroy it, both in
 * Alchemy's test runtime with `options`' providers. The leading destroy
 * drains what a killed run left.
 */
export const deployedWith = <A, E, ROut>(
  options: Core.MakeOptions<ROut>,
  stack: Core.ScratchStack<ROut>,
  program: Effect.Effect<A, E, ROut | StackServices>,
) =>
  Effect.flatMap(Effect.scope, (scope) =>
    CoreModule.toEffect(
      Effect.acquireRelease(
        Effect.andThen(keepResources ? Effect.void : stack.destroy(), stack.deploy(program)),
        () => (keepResources ? Effect.void : stack.destroy().pipe(Effect.orDie)),
      ),
      options,
      scope,
    ),
  ).pipe(Effect.orDie);

/** {@link deployedWith} Docker's providers: a file's containers. */
export const deployed = <A, E>(
  stack: Core.ScratchStack<DockerProviders>,
  program: Effect.Effect<A, E, DockerProviders | StackServices>,
) => deployedWith(testOptions, stack, program);

type DockerProviders = Layer.Success<typeof testOptions.providers>;

/** What a program deployed on a file's Docker stack may require. */
export type DockerStack = DockerProviders | StackServices;

/**
 * Run `argv` inside a deployed container (`docker container exec`) through
 * Alchemy's Docker service, as the Docker suites do; its standard output.
 */
export const execIn = (container: string, argv: ReadonlyArray<string>) =>
  CoreModule.toEffect(
    CoreModule.withProviders(
      Effect.flatMap(Docker.Docker, (docker) =>
        docker.run(["container", "exec", container, ...argv]),
      ),
      testOptions,
      "export-exec",
    ),
    testOptions,
  ).pipe(Effect.map((result: { readonly stdout: string }) => result.stdout));

/** A container port published on a fixed loopback port of the host. */
export interface Published {
  readonly port: number;
  readonly mapping: { readonly external: string; readonly internal: number };
}

/**
 * Publish a container's `internal` port on a host port free now, bound to
 * loopback. A port Docker picks (`external: 0`) changes when the container
 * restarts, and listens on every interface; this one does neither. The
 * kernel hands out the port, so it is none a running container holds.
 */
export const publish = (internal: number): Effect.Effect<Published> =>
  findAvailablePort().pipe(
    Effect.map((port) => ({ port, mapping: { external: `127.0.0.1:${port}`, internal } })),
    Effect.orDie,
  );

/** A readiness poll that ran out of time. */
export class NotReady extends Data.TaggedError("NotReady")<{
  readonly what: string;
  readonly seconds: number;
}> {
  override get message() {
    return `${this.what} was not ready within ${this.seconds} seconds`;
  }
}

/** Polls `ready` until it holds, for at most 90 seconds: a slower service is a bug to fix, not to wait on. */
export const waitFor = <E, R>(what: string, ready: Effect.Effect<boolean, E, R>) =>
  ready.pipe(
    Effect.filterOrFail(
      (ok) => ok,
      () => new NotReady({ what, seconds: 90 }),
    ),
    Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "90 seconds" }))),
    Effect.orDie,
  );

/** A request to a fixture's HTTP API: what a setup step or a probe sends. */
export interface Request {
  readonly method?: "GET" | "POST" | "PUT" | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
}

/** A fixture's HTTP API answered outside 2xx. */
export class RequestFailed extends Data.TaggedError("RequestFailed")<{
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
}> {
  override get message() {
    return `${this.method} ${this.url}: ${this.status} ${this.body}`;
  }
}

/** Send `request` to `url` and read the body: a non-2xx answer is a `RequestFailed`. */
export const send = (url: string, request: Request = {}) => {
  const method = request.method ?? "GET";
  const outgoing = HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.setHeaders(request.headers ?? {}),
    (outgoing) =>
      request.body === undefined
        ? outgoing
        : HttpClientRequest.bodyText(outgoing, request.body, request.headers?.["content-type"]),
  );
  return HttpClient.execute(outgoing).pipe(
    Effect.flatMap((response) =>
      Effect.flatMap(response.text, (body) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(body)
          : Effect.fail(new RequestFailed({ method, url, status: response.status, body })),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );
};

/** Whether `url` answers 2xx: a probe, so any failure is `false`. */
export const httpOk = (url: string, request?: Request) =>
  send(url, request).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** A setup request: a failure is a defect carrying the answer. */
export const call = (url: string, request?: Request) => send(url, request).pipe(Effect.orDie);

export const json = (method: "POST" | "PUT", body: unknown, token?: string): Request => ({
  method,
  headers: {
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify(body),
});

/** A JSON body decoded by `schema`, or a defect. */
export const decodeJson =
  <S extends Schema.Top>(schema: S) =>
  (body: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(Effect.orDie);

const TrinoColumn = Schema.Struct({ name: Schema.String, type: Schema.String });
const TrinoPage = Schema.Struct({
  nextUri: Schema.optionalKey(Schema.String),
  columns: Schema.optionalKey(Schema.Array(TrinoColumn)),
  data: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Unknown))),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String, errorName: Schema.String })),
});

/** Trino refused or failed a statement. */
export class TrinoQueryFailed extends Data.TaggedError("TrinoQueryFailed")<{
  readonly errorName: string;
  readonly detail: string;
}> {
  override get message() {
    return `${this.errorName}: ${this.detail}`;
  }
}

/** One page of Trino's REST protocol: a failure (not a defect), so a readiness poll can retry it. */
const trinoPage = (url: string, request: Request) =>
  send(url, request).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TrinoPage))),
  );

/**
 * One statement over Trino's REST protocol, its pages followed: the columns
 * (name and Trino type) and every row's cells, as Trino's JSON. The session
 * runs as `user`, in `catalog` and `schema` when given.
 */
export const trinoQuery = (
  url: string,
  statement: string,
  session: { readonly user?: string; readonly catalog?: string; readonly schema?: string } = {},
) =>
  Effect.gen(function* () {
    const headers = {
      "X-Trino-User": session.user ?? "probe",
      ...(session.catalog === undefined ? {} : { "X-Trino-Catalog": session.catalog }),
      ...(session.schema === undefined ? {} : { "X-Trino-Schema": session.schema }),
    };
    const rows: Array<ReadonlyArray<unknown>> = [];
    let columns: ReadonlyArray<typeof TrinoColumn.Type> = [];
    let page = yield* trinoPage(`${url}/v1/statement`, {
      method: "POST",
      body: statement,
      headers,
    });
    for (;;) {
      columns = page.columns ?? columns;
      rows.push(...(page.data ?? []));
      if (page.error !== undefined)
        return yield* new TrinoQueryFailed({
          errorName: page.error.errorName,
          detail: page.error.message,
        });
      if (page.nextUri === undefined) return { columns, rows };
      page = yield* trinoPage(page.nextUri, { headers });
    }
  });

/** One statement's rows over Trino's REST protocol. */
export const trino = (url: string, statement: string) =>
  Effect.map(trinoQuery(url, statement), (result) => result.rows);
