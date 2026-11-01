import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The newest public Ubuntu image of the region, resolved at plan. */
const ubuntuImage = Output.fromEffect(
  Effect.gen(function* () {
    const { projectId, region } = yield* Stackit.StackitEnvironment.current;
    const { items } = yield* iaas.listImages({ projectId, region, all: true });
    return items
      .filter((image) => image.scope === "public" && /ubuntu/i.test(image.name) && image.id)
      .sort((a, b) => b.name.localeCompare(a.name))[0]!.id!;
  }).pipe(Effect.orDie),
);

export const Web = Effect.gen(function* () {
  const network = yield* Stackit.IaaS.Network("RunCommandBindingsNetwork", {
    ipv4: { prefix: "10.231.93.0/24" },
  });
  return yield* Stackit.IaaS.Server("RunCommandBindingsServer", {
    machineType: "g1.1",
    bootVolume: { size: 10, source: { type: "image", id: ubuntuImage }, deleteOnTermination: true },
    networking: { networkId: network.networkId },
    agent: { provisioned: true },
  });
});

/** What a command's script and output came back as. */
const plain = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * A Cloudflare Worker using the Run Command bindings on a server, signing with the
 * service account Alchemy creates for it. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class RunCommandBindingsWorker extends Cloudflare.Worker<RunCommandBindingsWorker>()(
  "StackitRunCommandBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const server = yield* Web;
    const create = yield* Stackit.RunCommand.CreateCommand(server);
    const get = yield* Stackit.RunCommand.GetCommand(server);
    const list = yield* Stackit.RunCommand.ListCommands(server);
    const getTemplate = yield* Stackit.RunCommand.GetCommandTemplate(server);

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
        switch (url.pathname) {
          case "/create":
            return yield* respond(
              create({
                commandTemplateName: "RunShellScript",
                parameters: { script: url.searchParams.get("script") ?? "" },
              }),
            );
          case "/get":
            return yield* respond(
              get({ commandId: url.searchParams.get("id") ?? "" }).pipe(
                Effect.map((command) => ({
                  status: command.status,
                  exitCode: command.exitCode,
                  output: plain(command.output),
                })),
              ),
            );
          case "/list":
            return yield* respond(list());
          case "/template":
            return yield* respond(getTemplate({ commandTemplateName: "RunShellScript" }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.RunCommand.CreateCommandHttp,
        Stackit.RunCommand.GetCommandHttp,
        Stackit.RunCommand.ListCommandsHttp,
        Stackit.RunCommand.GetCommandTemplateHttp,
      ),
    ),
  ),
) {}
