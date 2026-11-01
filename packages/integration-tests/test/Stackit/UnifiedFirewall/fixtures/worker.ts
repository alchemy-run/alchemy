import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** What the runtime rules target, and the project and region the bindings bind to. */
export const Group = Stackit.IaaS.SecurityGroup("UfwBindingsGroup", {});

export const Team = Stackit.ResourceManager.Folder("UfwBindingsFolder", {});

/** The profile's organization: the API names it by UUID, not by a folder's `parentId`. */
const organizationId = Output.fromEffect(
  Effect.gen(function* () {
    const env = yield* Stackit.StackitEnvironment.current;
    return yield* Stackit.requireOrganizationId(env);
  }).pipe(Effect.orDie),
) as Output.Output<string>;

/**
 * A Cloudflare Worker with every Unified Firewall binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class UfwBindingsWorker extends Cloudflare.Worker<UfwBindingsWorker>()(
  "StackitUfwBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const group = yield* Group;
    const team = yield* Team;
    const getRule = yield* Stackit.UnifiedFirewall.GetRule(group);
    const listRules = yield* Stackit.UnifiedFirewall.ListRules(group);
    const createRule = yield* Stackit.UnifiedFirewall.CreateRule(group);
    const updateRule = yield* Stackit.UnifiedFirewall.UpdateRule(group);
    const deleteRule = yield* Stackit.UnifiedFirewall.DeleteRule(group);
    const listProviderOptions = yield* Stackit.UnifiedFirewall.ListProviderOptions(group);
    const listFolderContainers = yield* Stackit.UnifiedFirewall.ListFolderContainers(team);
    const listOrganizationContainers =
      yield* Stackit.UnifiedFirewall.ListOrganizationContainers(organizationId);
    const readRules = yield* Stackit.UnifiedFirewall.ReadRules(group);
    const writeRules = yield* Stackit.UnifiedFirewall.WriteRules(group);
    const readWriteRules = yield* Stackit.UnifiedFirewall.ReadWriteRules(group);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        const newRule = () => ({
          product: param("product"),
          instanceId: param("instance"),
          securityGroupId: param("instance"),
          type: "SecurityRule",
          sourceIP: param("source"),
          direction: "ingress",
          etherType: "IPv4",
          protocol: "TCP",
          portRange: "8080-8090",
        });
        switch (url.pathname) {
          case "/get-rule":
            return yield* respond(getRule({ ruleId: param("id") }));
          case "/list-rules":
            return yield* respond(listRules({ instanceId: param("instance") }));
          case "/create-rule":
            return yield* respond(createRule(newRule()));
          case "/update-rule":
            return yield* respond(updateRule({ ruleId: param("id"), sourceIP: param("source") }));
          case "/delete-rule":
            return yield* respond(deleteRule({ ruleId: param("id") }));
          case "/list-provider-options":
            return yield* respond(listProviderOptions());
          case "/list-folder-containers":
            return yield* respond(listFolderContainers({ limit: 100 }));
          case "/list-organization-containers":
            return yield* respond(listOrganizationContainers({ limit: 100 }));
          case "/read-rules":
            return yield* respond(
              Effect.all({
                rule: readRules.getRule({ ruleId: param("id") }),
                listed: readRules.listRules({ instanceId: param("instance") }),
              }),
            );
          case "/write-rules":
            return yield* respond(writeRules.createRule(newRule()));
          case "/read-write-rules":
            return yield* respond(
              // An update, because a route's call is retried: a create here could leave rules.
              Effect.gen(function* () {
                yield* readWriteRules.updateRule({
                  ruleId: param("id"),
                  sourceIP: param("source"),
                });
                return yield* readWriteRules.getRule({ ruleId: param("id") });
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.UnifiedFirewall.GetRuleHttp,
        Stackit.UnifiedFirewall.ListRulesHttp,
        Stackit.UnifiedFirewall.CreateRuleHttp,
        Stackit.UnifiedFirewall.UpdateRuleHttp,
        Stackit.UnifiedFirewall.DeleteRuleHttp,
        Stackit.UnifiedFirewall.ListProviderOptionsHttp,
        Stackit.UnifiedFirewall.ListFolderContainersHttp,
        Stackit.UnifiedFirewall.ListOrganizationContainersHttp,
        Stackit.UnifiedFirewall.ReadRulesHttp,
        Stackit.UnifiedFirewall.WriteRulesHttp,
        Stackit.UnifiedFirewall.ReadWriteRulesHttp,
      ),
    ),
  ),
) {}
