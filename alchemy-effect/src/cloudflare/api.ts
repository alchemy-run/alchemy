import * as cf from "cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class CloudflareApi extends Context.Tag("CloudflareApi")<
  CloudflareApi,
  cf.Cloudflare
>() {}

export class CloudflareAccountId extends Context.Tag("CloudflareAccountId")<
  CloudflareAccountId,
  string
>() {}

export class CloudflareEmail extends Context.Tag("CloudflareEmail")<
  CloudflareEmail,
  string
>() {}

export class CloudflareApiKey extends Context.Tag("CloudflareApiKey")<
  CloudflareApiKey,
  string
>() {}

export class CloudflareApiToken extends Context.Tag("CloudflareApiToken")<
  CloudflareApiToken,
  string
>() {}

export class CloudflareBaseUrl extends Context.Tag("CloudflareBaseUrl")<
  CloudflareBaseUrl,
  string
>() {}

const tryGet = <Tag extends Context.Tag<any, any>>(
  tag: Tag,
  defaultValue: Tag["Service"] | undefined,
) =>
  Effect.gen(function* () {
    const value = yield* Effect.serviceOption(tag);
    return Option.getOrElse(value, () => defaultValue);
  });

export const cloudflareApi = Layer.effect(
  CloudflareApi,
  Effect.gen(function* () {
    const email = yield* tryGet(
      CloudflareEmail,
      import.meta.env.CLOUDFLARE_EMAIL,
    );
    const apiKey = yield* tryGet(
      CloudflareApiKey,
      import.meta.env.CLOUDFLARE_API_KEY,
    );
    const apiToken = yield* tryGet(
      CloudflareApiToken,
      import.meta.env.CLOUDFLARE_API_TOKEN,
    );
    const baseURL = yield* tryGet(
      CloudflareBaseUrl,
      import.meta.env.CLOUDFLARE_BASE_URL,
    );
    return new cf.Cloudflare({
      apiEmail: email,
      apiKey: apiKey,
      apiToken: apiToken,
      baseURL: baseURL,
    });
  }),
);
