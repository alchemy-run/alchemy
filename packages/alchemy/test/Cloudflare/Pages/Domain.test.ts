import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as pages from "@distilled.cloud/cloudflare/pages";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test names (never derived from Date.now() or
// randomness). Each test owns disjoint identifiers so reruns never collide.
const PROJECT_CRUD = "alchemy-e3-pages-dom-crud";
const PROJECT_REPLACE = "alchemy-e3-pages-dom-repl";
const DOMAIN_CRUD = `alchemy-pages-crud.${zoneName}`;
const DOMAIN_REPLACE_A = `alchemy-pages-replace-a.${zoneName}`;
const DOMAIN_REPLACE_B = `alchemy-pages-replace-b.${zoneName}`;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on the test's own out-of-band
// verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getDomain = (
  accountId: string,
  projectName: string,
  domainName: string,
) =>
  pages
    .getProjectDomain({ accountId, projectName, domainName })
    .pipe(Effect.retry(forbiddenRetry));

const expectDomainGone = (
  accountId: string,
  projectName: string,
  domainName: string,
) =>
  getDomain(accountId, projectName, domainName).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "DomainNotDeleted" } as const)),
    // A detached domain surfaces as `PagesDomainNotFound` (code 8000021);
    // if the whole project is gone the API reports `ProjectNotFound`
    // (code 8000007). Both mean the attachment no longer exists.
    Effect.catchTag("PagesDomainNotFound", () => Effect.void),
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "DomainNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// Purge leftovers from interrupted runs so deterministically-named tests
// start from a clean slate (deleting the project detaches its domains).
const purgeProject = (accountId: string, projectName: string) =>
  pages.deleteProject({ accountId, projectName }).pipe(
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry(forbiddenRetry),
  );

test.provider("attach and detach a custom domain", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, PROJECT_CRUD);

    const { project, domain } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.PagesProject("DomainCrudProject", {
          name: PROJECT_CRUD,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.PagesDomain("CrudDomain", {
          projectName: project.name,
          name: DOMAIN_CRUD,
        }).pipe(adopt(true));
        return { project, domain };
      }),
    );

    expect(domain.domainId).toBeDefined();
    expect(domain.accountId).toEqual(accountId);
    expect(domain.projectName).toEqual(project.name);
    expect(domain.name).toEqual(DOMAIN_CRUD);
    // The zone lives on the same account, so Cloudflare resolves the
    // zone tag immediately. Certificate issuance is asynchronous — the
    // domain may legitimately stay pending; this test exercises CRUD,
    // not certificate issuance.
    expect(domain.zoneTag).toBeTruthy();
    expect(domain.status).toBeTruthy();
    expect(domain.createdOn).toBeTruthy();

    const live = yield* getDomain(accountId, project.name, DOMAIN_CRUD);
    expect(live.domainId).toEqual(domain.domainId);
    expect(live.name).toEqual(DOMAIN_CRUD);

    // Redeploying identical props is a no-op (same attachment).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.PagesProject("DomainCrudProject", {
          name: PROJECT_CRUD,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.PagesDomain("CrudDomain", {
          projectName: project.name,
          name: DOMAIN_CRUD,
        }).pipe(adopt(true));
        return { project, domain };
      }),
    );
    expect(noop.domain.domainId).toEqual(domain.domainId);

    yield* stack.destroy();

    yield* expectDomainGone(accountId, PROJECT_CRUD, DOMAIN_CRUD);
  }).pipe(logLevel),
);

test.provider("changing the domain name triggers replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, PROJECT_REPLACE);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.PagesProject("DomainReplProject", {
          name: PROJECT_REPLACE,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.PagesDomain("ReplaceDomain", {
          projectName: project.name,
          name: DOMAIN_REPLACE_A,
        }).pipe(adopt(true));
        return domain;
      }),
    );

    expect(initial.name).toEqual(DOMAIN_REPLACE_A);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.PagesProject("DomainReplProject", {
          name: PROJECT_REPLACE,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.PagesDomain("ReplaceDomain", {
          projectName: project.name,
          name: DOMAIN_REPLACE_B,
        }).pipe(adopt(true));
        return domain;
      }),
    );

    // The domain name is the attachment's identity — a new physical
    // attachment exists.
    expect(replaced.domainId).not.toEqual(initial.domainId);
    expect(replaced.name).toEqual(DOMAIN_REPLACE_B);

    // The old domain was detached as part of the replacement.
    yield* expectDomainGone(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_A);

    const live = yield* getDomain(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_B);
    expect(live.domainId).toEqual(replaced.domainId);

    yield* stack.destroy();

    yield* expectDomainGone(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_B);
  }).pipe(logLevel),
);
