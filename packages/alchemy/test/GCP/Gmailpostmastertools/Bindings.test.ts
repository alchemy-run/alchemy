import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "GetDomain and GetDomainsUser round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* GCP.Gmailpostmastertools.Domain("Mail", {});
          const user = yield* GCP.Gmailpostmastertools.DomainsUser("Ada", {
            parent: domain.name,
            permission: "READER",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* domain.name;
              yield* user.name;
              const getDomain =
                yield* GCP.Gmailpostmastertools.GetDomain(domain);
              const getUser =
                yield* GCP.Gmailpostmastertools.GetDomainsUser(user);
              const queryStats =
                yield* GCP.Gmailpostmastertools.QueryDomainStats(domain);
              return Effect.fn(function* () {
                const domainMeta = yield* getDomain({});
                const userMeta = yield* getUser({});
                const stats = yield* queryStats({
                  body: {
                    metricDefinitions: [
                      {
                        name: "spam",
                        baseMetric: { standardMetric: "SPAM_RATE" },
                      },
                    ],
                    timeQuery: {
                      dateList: { dates: [{ year: 2026, month: 1, day: 1 }] },
                    },
                  },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { domainMeta, userMeta, stats };
              });
            }),
          );
          const probe = yield* Probe({});
          return {
            domain,
            user,
            domainMeta: probe.domainMeta,
            userMeta: probe.userMeta,
            stats: probe.stats,
          };
        }),
      );

      expect(out.domainMeta.name).toEqual(out.domain.name);
      expect(out.userMeta.permission).toEqual("READER");
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.stats.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
