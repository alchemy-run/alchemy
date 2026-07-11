import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as LexV2 from "@/AWS/LexV2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LexTestFunction extends Lambda.Function<Lambda.Function>()(
  "LexTestFunction",
) {}

export default LexTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The whole Lex chain: role -> bot -> DRAFT locale -> intent -> built
    // version -> alias. BotVersion builds the locale before snapshotting.
    const role = yield* IAM.Role("LexBotRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lexv2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });
    const bot = yield* LexV2.Bot("E2EBot", {
      roleArn: role.roleArn,
      description: "alchemy lex recognize-text e2e bot",
    });
    const locale = yield* LexV2.BotLocale("En", {
      botId: bot.botId,
      localeId: "en_US",
    });
    const greet = yield* LexV2.Intent("Greet", {
      botId: locale.botId,
      localeId: locale.localeId,
      intentName: "Greet",
      sampleUtterances: ["hello", "hi", "hey there"],
    });
    const version = yield* LexV2.BotVersion("V1", {
      botId: greet.botId,
      localeIds: [greet.localeId],
    });
    const alias = yield* LexV2.BotAlias("Live", {
      botId: version.botId,
      botVersion: version.botVersion,
    });

    const recognizeText = yield* LexV2.RecognizeText(alias);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "POST" && url.pathname === "/recognize") {
          const body = (yield* request.json) as unknown as {
            text: string;
            sessionId: string;
          };
          const result = yield* Effect.result(
            recognizeText({
              localeId: "en_US",
              sessionId: body.sessionId,
              text: body.text,
            }),
          );
          if (Result.isFailure(result)) {
            // Surface the typed tag so the test can distinguish IAM
            // propagation (retryable) from a real defect.
            return yield* HttpServerResponse.json(
              {
                error: result.failure._tag,
                message: String(
                  (result.failure as { message?: string }).message ?? "",
                ),
              },
              { status: 502 },
            );
          }
          const reply = result.success;
          return yield* HttpServerResponse.json({
            intent: reply.sessionState?.intent?.name ?? null,
            interpretations: (reply.interpretations ?? []).map(
              (interpretation) => interpretation.intent?.name,
            ),
          });
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname: url.pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(LexV2.RecognizeTextHttp)),
);
