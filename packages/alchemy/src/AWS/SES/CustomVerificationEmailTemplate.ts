import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface CustomVerificationEmailTemplateProps {
  /**
   * Name of the template. May contain letters, numbers, dashes and
   * underscores, up to 64 characters. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID. Changing the name
   * replaces the template.
   */
  templateName?: string;
  /**
   * The verified email address the verification email is sent from. The
   * identity must already be verified for sending.
   */
  fromEmailAddress: string;
  /**
   * The subject line of the verification email.
   */
  templateSubject: string;
  /**
   * The HTML body of the verification email. Must contain a link to the
   * verification URL SES generates.
   */
  templateContent: string;
  /**
   * The URL the recipient is redirected to after successfully verifying.
   */
  successRedirectionURL: string;
  /**
   * The URL the recipient is redirected to if verification fails.
   */
  failureRedirectionURL: string;
}

export interface CustomVerificationEmailTemplate extends Resource<
  "AWS.SES.CustomVerificationEmailTemplate",
  CustomVerificationEmailTemplateProps,
  {
    /** Name of the template. */
    templateName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 custom verification email template — the branded email SES
 * sends when you verify a new email-address identity via
 * `SendCustomVerificationEmail`.
 *
 * Creating, reading, updating, and deleting the template works on any account.
 * Actually *sending* a custom verification email requires the account to be
 * out of the SES sandbox (production access).
 * @resource
 * @section Creating Templates
 * @example Branded Verification Email
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const template = yield* SES.CustomVerificationEmailTemplate("Verify", {
 *   fromEmailAddress: "verify@example.com",
 *   templateSubject: "Please confirm your email",
 *   templateContent:
 *     "<html><body>Click the link to verify your address.</body></html>",
 *   successRedirectionURL: "https://example.com/verified",
 *   failureRedirectionURL: "https://example.com/verify-failed",
 * });
 * ```
 */
export const CustomVerificationEmailTemplate =
  Resource<CustomVerificationEmailTemplate>(
    "AWS.SES.CustomVerificationEmailTemplate",
  );

export const CustomVerificationEmailTemplateProvider = () =>
  Provider.effect(
    CustomVerificationEmailTemplate,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<CustomVerificationEmailTemplateProps, "templateName">,
      ) {
        return (
          props.templateName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getTemplate = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getCustomVerificationEmailTemplate({ TemplateName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return CustomVerificationEmailTemplate.Provider.of({
        stables: ["templateName"],

        // Account/region-scoped: enumerate every template so leaked test
        // resources are cleaned by nuke. Custom verification email templates
        // carry no ownership signal, so existence is treated as ownership.
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listCustomVerificationEmailTemplates
            .pages({})
            .pipe(Stream.runCollect);
          return Array.from(pages)
            .flatMap((page) => page.CustomVerificationEmailTemplates ?? [])
            .flatMap((meta) =>
              meta.TemplateName ? [{ templateName: meta.TemplateName }] : [],
            );
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.templateName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getTemplate(name);
          return found ? { templateName: name } : undefined;
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.templateName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* getTemplate(name);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createCustomVerificationEmailTemplate({
                TemplateName: name,
                FromEmailAddress: news.fromEmailAddress,
                TemplateSubject: news.templateSubject,
                TemplateContent: news.templateContent,
                SuccessRedirectionURL: news.successRedirectionURL,
                FailureRedirectionURL: news.failureRedirectionURL,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateCustomVerificationEmailTemplate({
                    TemplateName: name,
                    FromEmailAddress: news.fromEmailAddress,
                    TemplateSubject: news.templateSubject,
                    TemplateContent: news.templateContent,
                    SuccessRedirectionURL: news.successRedirectionURL,
                    FailureRedirectionURL: news.failureRedirectionURL,
                  }),
                ),
              );
          } else if (
            observed.FromEmailAddress !== news.fromEmailAddress ||
            observed.TemplateSubject !== news.templateSubject ||
            observed.TemplateContent !== news.templateContent ||
            observed.SuccessRedirectionURL !== news.successRedirectionURL ||
            observed.FailureRedirectionURL !== news.failureRedirectionURL
          ) {
            // 3. SYNC — a single full-replace update converges the template.
            yield* sesv2.updateCustomVerificationEmailTemplate({
              TemplateName: name,
              FromEmailAddress: news.fromEmailAddress,
              TemplateSubject: news.templateSubject,
              TemplateContent: news.templateContent,
              SuccessRedirectionURL: news.successRedirectionURL,
              FailureRedirectionURL: news.failureRedirectionURL,
            });
          }

          return { templateName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* sesv2
            .deleteCustomVerificationEmailTemplate({
              TemplateName: output.templateName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
