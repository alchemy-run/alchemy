import * as Lambda from "@/AWS/Lambda";
import * as SES from "@/AWS/SES";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// The SES mailbox simulator accepts mail even in the sandbox.
const SIMULATOR = "success@simulator.amazonses.com";

export class SESTestFunction extends Lambda.Function<Lambda.Function>()(
  "SESTestFunction",
) {}

export default SESTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Domain identity — deterministic, never verified. In the SES sandbox a
    // send from it fails with a typed MessageRejected; the ungated test
    // asserts exactly that tag. A verified from-address can be supplied per
    // request (?from=...) to exercise the success path.
    const identity = yield* SES.EmailIdentity("SendIdentity", {
      emailIdentity: "ses-bindings.alchemy-test.example.com",
    });
    const configSet = yield* SES.ConfigurationSet("SendConfigSet", {});
    const template = yield* SES.EmailTemplate("SendTemplate", {
      subject: "Hello, {{name}}!",
      text: "Hi {{name}}.",
    });

    const sendEmail = yield* SES.SendEmail(identity, configSet);
    const sendWithoutConfigSet = yield* SES.SendEmail(identity);
    const TemplateName = yield* template.templateName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? SIMULATOR;

        const respond = <E extends { _tag: string; message?: string }>(
          send: Effect.Effect<{ MessageId?: string }, E>,
        ) =>
          send.pipe(
            Effect.flatMap((result) =>
              HttpServerResponse.json({ messageId: result.MessageId }),
            ),
            Effect.catch((e) =>
              HttpServerResponse.json({
                error: e._tag,
                message: "message" in e ? e.message : undefined,
              }),
            ),
          );

        if (request.method === "POST" && pathname === "/send-simple") {
          return yield* respond(
            sendEmail({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Simple: {
                  Subject: { Data: "alchemy SES binding test" },
                  Body: { Text: { Data: "Hello from the SendEmail binding." } },
                },
              },
            }),
          );
        }

        if (request.method === "POST" && pathname === "/send-template") {
          const templateName = yield* TemplateName;
          return yield* respond(
            sendEmail({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Template: {
                  TemplateName: templateName,
                  TemplateData: JSON.stringify({ name: "Ada" }),
                },
              },
            }),
          );
        }

        if (request.method === "POST" && pathname === "/send-plain") {
          return yield* respond(
            sendWithoutConfigSet({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Simple: {
                  Subject: { Data: "alchemy SES binding test (no config set)" },
                  Body: { Text: { Data: "Hello without a config set." } },
                },
              },
            }),
          );
        }

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SES.SendEmailHttp)),
);
