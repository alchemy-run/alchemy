import { refuseProtected } from "@alchemy.run/convex/aws/StageDatabase";
import {
  assertInstanceNameUnchanged,
  assertNoReservedEnv,
  assertPinnedImage,
  assertHostTemplate,
  assertStageHosts,
  backendHosts,
  backendHostsProblem,
  certificateCovers,
  certificateNames,
  hostLabelOf,
  backendEnv,
  backendTuning,
  type BackendEnv,
  databaseName,
  databaseUrl,
  instanceNameOf,
  isStagePrefix,
  stageHosts,
  storagePrefixPattern,
  withoutDatabaseName,
} from "@alchemy.run/convex/internal/selfhosted";
import { expect, it as test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const size = { cpu: 512, memory: 1024 };

test(
  "databaseName swaps hyphens for underscores",
  () => {
    expect(databaseName("my-app-pr-42")).toBe("my_app_pr_42");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "instanceNameOf is lowercase letters, digits and hyphens",
  () => {
    expect(instanceNameOf("MyApp", "Christian_Stamati")).toBe("myapp-christian-stamati");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "instanceNameOf stays short, and long names stay distinct",
  () => {
    const a = instanceNameOf("a".repeat(40), `${"b".repeat(40)}1`);
    const b = instanceNameOf("a".repeat(40), `${"b".repeat(40)}2`);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(a).not.toBe(b);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "storagePrefixPattern matches one instance's UUID prefix",
  () => {
    expect(storagePrefixPattern("pr")).toBe("pr-????????-????-????-????-????????????/*");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "isStagePrefix keeps a stage away from a longer stage's keys",
  () => {
    expect(isStagePrefix("pr", "pr-3f2b9c1e-0000-4000-8000-000000000000/a")).toBe(true);
    expect(isStagePrefix("pr", "pr-42-3f2b9c1e-0000-4000-8000-000000000000/a")).toBe(false);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "backendEnv puts defaults under tuning under the user",
  () => {
    expect(backendEnv({ size, env: {} }).DOCUMENT_RETENTION_DELAY).toBe("172800");
    expect(backendEnv({ size, env: {} }).DISABLE_BEACON).toBe("true");
    expect(backendEnv({ size, env: {} }).APPLICATION_MAX_CONCURRENT_QUERIES).toBe("16");
    expect(backendEnv({ size, env: { RUST_LOG: "debug" } }).RUST_LOG).toBe("debug");
    expect(backendEnv({ size, env: { V8_THREADS: "9" } }).V8_THREADS).toBe("9");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "backendTuning scales with the task",
  () => {
    const small = backendTuning({ cpu: 256, memory: 512 });
    const large = backendTuning({ cpu: 1024, memory: 2048 });
    expect(small.V8_THREADS).toBe("2");
    expect(small.MAX_ISOLATE_WORKERS).toBe("8");
    expect(small.UDF_CACHE_MAX_SIZE).toBe(String(16 * 1024 * 1024));
    expect(large.RUNTIME_WORKER_THREADS).toBe("2");
    expect(large.MAX_ISOLATE_WORKERS).toBe("8");
    expect(large.INDEX_CACHE_SIZE).toBe(String(128 * 1024 * 1024));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "the CA paths are reserved",
  async () => {
    const error = await assertNoReservedEnv({ PG_CA_FILE: "x" }).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error.message).toContain("PG_CA_FILE");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertNoReservedEnv names what it refused",
  async () => {
    const error = await assertNoReservedEnv({ POSTGRES_URL: "x", OK: "y" }).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("ReservedEnvError");
    expect(error.message).toContain("POSTGRES_URL");
    expect(error.message).not.toContain("OK");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a reserved env name doesn't compile",
  () => {
    // @ts-expect-error set by the resource
    const env: BackendEnv = { POSTGRES_URL: "x" };
    // @ts-expect-error set by the resource
    const other: BackendEnv = { INSTANCE_SECRET: "x" };
    const allowed: BackendEnv = { RUST_LOG: "debug" };
    expect([env, other, allowed].length).toBe(3);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertPinnedImage refuses a floating tag",
  async () => {
    const error = await assertPinnedImage("ghcr.io/convex/convex-backend:latest").pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("UnpinnedImage");
    await Effect.runPromise(
      assertPinnedImage(`ghcr.io/convex/convex-backend:latest@sha256:${"a".repeat(64)}`),
    );
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertInstanceNameUnchanged only refuses a real change",
  async () => {
    const error = await assertInstanceNameUnchanged("a", "b").pipe(Effect.flip, Effect.runPromise);
    expect(error._tag).toBe("InstanceNameChanged");
    await Effect.runPromise(assertInstanceNameUnchanged("a", "a"));
    await Effect.runPromise(assertInstanceNameUnchanged(undefined, "b"));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "withoutDatabaseName strips path and query",
  async () => {
    const url = await Effect.runPromise(
      withoutDatabaseName(Redacted.make("postgres://u:p@h:5432/db?ssl=true")),
    );
    expect(Redacted.value(url)).toBe("postgres://u:p@h:5432");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "withoutDatabaseName never repeats a URL it can't read",
  async () => {
    const error = await withoutDatabaseName(Redacted.make("not a url with p4ssw0rd")).pipe(
      Effect.flip,
      Effect.runPromise,
    );
    expect(error._tag).toBe("InvalidDatabaseUrl");
    expect(error.message).not.toContain("p4ssw0rd");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "stageHosts for production",
  () => {
    expect(stageHosts("domain.com", "prod", true)).toEqual({
      web: "domain.com",
      cloud: "cloud.domain.com",
      site: "site.domain.com",
    });
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a stage is the one leftmost label, so the platform certificate covers it",
  () => {
    const hosts = stageHosts("previews.example.com", "christian-stamati", false);
    expect(hosts).toEqual({
      web: "christian-stamati.previews.example.com",
      cloud: "christian-stamati.cloud.previews.example.com",
      site: "christian-stamati.site.previews.example.com",
    });
    const { domainName, subjectAlternativeNames } = certificateNames("previews.example.com");
    const covers = (host: string) =>
      host === domainName ||
      subjectAlternativeNames.some(
        (name) => name.startsWith("*.") && host.split(".").slice(1).join(".") === name.slice(2),
      );
    for (const host of Object.values(hosts)) expect(covers(host)).toBe(true);
    for (const host of Object.values(stageHosts("example.com", "prod", true))) {
      expect(covers(host.replace("example.com", "previews.example.com"))).toBe(true);
    }
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertStageHosts refuses a stage that claims the production host",
  async () => {
    for (const stage of ["cloud", "site"]) {
      const error = await assertStageHosts(stage).pipe(Effect.flip, Effect.runPromise);
      expect(error._tag).toBe("InvalidStageName");
    }
    await Effect.runPromise(assertStageHosts("pr-42"));
    await Effect.runPromise(assertStageHosts("staging-cloud"));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertStageHosts refuses what can't be a hostname label",
  async () => {
    await assertStageHosts("Bad_Stage").pipe(Effect.flip, Effect.runPromise);
    await assertStageHosts("a".repeat(64)).pipe(Effect.flip, Effect.runPromise);
    await Effect.runPromise(assertStageHosts("a".repeat(63)));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a protected stage database refuses to be dropped",
  async () => {
    const error = await refuseProtected({
      databaseName: "app_prod",
      url: Redacted.make("x"),
      deletionProtection: true,
    }).pipe(Effect.flip, Effect.runPromise);
    expect(error._tag).toBe("StageDatabaseProtected");
    expect(error.message).toContain("deletionProtection");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "an unprotected stage database may go",
  async () => {
    await Effect.runPromise(
      refuseProtected({
        databaseName: "app_pr_1",
        url: Redacted.make("x"),
        deletionProtection: false,
      }),
    );
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "databaseUrl turns TLS off only when asked, and only for postgres",
  async () => {
    const url = Redacted.make("postgres://u:p@h:5432/db?ssl=true");
    const plain = await Effect.runPromise(databaseUrl("postgres", url, false));
    expect(Redacted.value(plain)).toBe("postgres://u:p@h:5432?sslmode=disable");
    const strict = await Effect.runPromise(databaseUrl("postgres", url, true));
    expect(Redacted.value(strict)).toBe("postgres://u:p@h:5432");
    const mysql = await Effect.runPromise(
      databaseUrl("mysql", Redacted.make("mysql://u:p@h:3306"), false),
    );
    expect(Redacted.value(mysql)).toBe("mysql://u:p@h:3306");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "stageHosts uses the bare domain on prod, and a stage host elsewhere",
  () => {
    expect(stageHosts("example.com", "pr-42", false).cloud).toContain("pr-42");
    expect(stageHosts("example.com", "prod", true).cloud).toContain("example.com");
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "hostLabelOf turns any stage name into a hostname label",
  async () => {
    expect(hostLabelOf("dev_Sam")).toBe("dev-sam");
    expect(hostLabelOf("pr-42")).toBe("pr-42");
    expect(hostLabelOf("_x_")).toBe("x");
    await Effect.runPromise(assertStageHosts(hostLabelOf("dev_sam")));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

const covered = (domain: string, template?: Parameters<typeof certificateNames>[1]) => {
  const names = certificateNames(domain, template);
  return [names.domainName, ...names.subjectAlternativeNames];
};

test(
  "the default host template keeps the platform certificate's names",
  () => {
    expect(certificateNames("previews.example.com")).toEqual({
      domainName: "previews.example.com",
      subjectAlternativeNames: [
        "*.previews.example.com",
        "*.cloud.previews.example.com",
        "*.site.previews.example.com",
      ],
    });
    expect(
      certificateNames("previews.example.com", {
        web: "{stage}.{domain}",
        cloud: "{stage}.cloud.{domain}",
        site: "{stage}.site.{domain}",
      }),
    ).toEqual(certificateNames("previews.example.com"));
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a flat host template with {app} needs one wildcard",
  () => {
    const template = { cloud: "{stage}-{app}-api.{domain}", site: "{stage}-{app}-site.{domain}" };
    expect(certificateNames("preview.example.com", template).subjectAlternativeNames).toEqual([
      "*.preview.example.com",
    ]);
    expect(
      stageHosts("preview.example.com", "pippo", false, { hosts: template, app: "shop" }),
    ).toEqual({
      web: "pippo.preview.example.com",
      cloud: "pippo-shop-api.preview.example.com",
      site: "pippo-shop-site.preview.example.com",
    });
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a wildcard certificate name covers exactly one label",
  () => {
    expect(certificateCovers("*.example.com", "a.example.com")).toBe(true);
    expect(certificateCovers("*.example.com", "a.b.example.com")).toBe(false);
    expect(certificateCovers("*.example.com", "example.com")).toBe(false);
    expect(certificateCovers("example.com", "example.com")).toBe(true);
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "assertHostTemplate refuses templates a wildcard certificate can't cover",
  async () => {
    const refused = [
      { cloud: "cloud.{stage}.{domain}" },
      { cloud: "api.{domain}" },
      { cloud: "{stage}.{app}.{domain}" },
      { cloud: "{stage}.cloud.example.com" },
      { cloud: "{stage}.{domain}.cloud" },
      { cloud: "{stage}-{region}.{domain}" },
      { cloud: "{stage}_api.{domain}" },
      { cloud: "{stage}.site.{domain}" },
    ];
    for (const template of refused) {
      const error = await assertHostTemplate(template).pipe(Effect.flip, Effect.runPromise);
      expect(error._tag).toBe("InvalidHostTemplate");
    }
    await Effect.runPromise(assertHostTemplate(undefined));
    await Effect.runPromise(
      assertHostTemplate({
        cloud: "{stage}-{app}-api.{domain}",
        site: "{stage}-{app}-site.{domain}",
      }),
    );
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a backend's hosts come from the template, or from hosts it picks",
  () => {
    const domain = "preview.example.com";
    expect(backendHosts(domain, undefined, { stage: "pippo", production: false })).toEqual({
      cloud: "pippo.cloud.preview.example.com",
      site: "pippo.site.preview.example.com",
    });
    expect(backendHosts(domain, undefined, { stage: "prod", production: true })).toEqual({
      cloud: "cloud.preview.example.com",
      site: "site.preview.example.com",
    });
    const hosts = { cloud: "demo-api.preview.example.com", site: "demo-site.preview.example.com" };
    expect(
      backendHosts(domain, undefined, { stage: "Not A Label", production: false, hosts }),
    ).toEqual(hosts);
    for (const host of Object.values(hosts)) {
      expect(covered(domain).some((name) => certificateCovers(name, host))).toBe(true);
    }
  },
  { tags: ["unit", "provider:convex", "local"] },
);

test(
  "a backend can't take hosts the platform can't serve",
  () => {
    const domain = "preview.example.com";
    const appTemplate = {
      cloud: "{stage}-{app}-api.{domain}",
      site: "{stage}-{app}-site.{domain}",
    };
    const problems = [
      // {app} in the template, but no app
      backendHostsProblem(domain, appTemplate, { stage: "pippo", production: false }),
      // app with a template that ignores it
      backendHostsProblem(domain, undefined, { stage: "pippo", production: false, app: "shop" }),
      // an app that isn't a label
      backendHostsProblem(domain, appTemplate, { stage: "pippo", production: false, app: "Shop!" }),
      // past the certificate's one wildcard label
      backendHostsProblem(domain, undefined, {
        stage: "pippo",
        production: false,
        hosts: { cloud: "a.b.preview.example.com", site: "b.preview.example.com" },
      }),
      // a stage claiming production's hosts
      backendHostsProblem(domain, undefined, {
        stage: "pippo",
        production: false,
        hosts: { cloud: "cloud.preview.example.com", site: "x.preview.example.com" },
      }),
      // a first label over 63 characters
      backendHostsProblem(domain, appTemplate, {
        stage: "a".repeat(60),
        production: false,
        app: "shop",
      }),
    ];
    for (const problem of problems) expect(problem).toBeDefined();
    expect(() => backendHosts(domain, appTemplate, { stage: "pippo", production: false })).toThrow(
      /set app/,
    );
    expect(
      backendHostsProblem(domain, appTemplate, { stage: "pippo", production: false, app: "shop" }),
    ).toBeUndefined();
  },
  { tags: ["unit", "provider:convex", "local"] },
);
