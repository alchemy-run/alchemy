import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";
import { SendEmail, type SendEmailRequest } from "./SendEmail.ts";

export const SendEmailHttp = Layer.effect(
  SendEmail,
  Effect.gen(function* () {
    const sendEmail = yield* sesv2.sendEmail;

    return Effect.fn(function* <I extends EmailIdentity>(
      identity: I,
      configurationSet?: ConfigurationSet,
    ) {
      const FromIdentity = yield* identity.emailIdentity;
      const ConfigurationSetName = configurationSet
        ? yield* configurationSet.configurationSetName
        : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          // Templated sends are authorized against the template resource, so
          // grant the account's templates alongside the bound identity.
          const templateArns = Output.all(identity.identityArn).pipe(
            Output.map(([identityArn]) =>
              identityArn.replace(/:identity\/.*$/, ":template/*"),
            ),
          );
          // For a domain identity, SES authorizes SendEmail against the
          // identity ARN of the FROM address (identity/user@domain), not the
          // domain identity ARN — grant addresses at the domain too.
          const addressArns = Output.all(identity.identityArn).pipe(
            Output.map(([identityArn]) =>
              identityArn.includes("@")
                ? identityArn
                : identityArn.replace(/:identity\//, ":identity/*@"),
            ),
          );
          yield* host.bind`Allow(${host}, AWS.SES.SendEmail(${identity}, ${configurationSet ?? "none"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "ses:SendEmail",
                    "ses:SendRawEmail",
                    "ses:SendTemplatedEmail",
                    "ses:SendBulkTemplatedEmail",
                  ],
                  Resource: [
                    identity.identityArn,
                    addressArns,
                    templateArns,
                    ...(configurationSet
                      ? [configurationSet.configurationSetArn]
                      : []),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SES.SendEmail(${identity.LogicalId})`)(function* (
        request: SendEmailRequest,
      ) {
        const fromIdentity = yield* FromIdentity;
        const configurationSetName = ConfigurationSetName
          ? yield* ConfigurationSetName
          : undefined;
        return yield* sendEmail({
          ...request,
          FromEmailAddress: request.FromEmailAddress ?? fromIdentity,
          ConfigurationSetName: configurationSetName,
        });
      });
    });
  }),
);
