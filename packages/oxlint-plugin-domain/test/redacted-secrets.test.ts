import * as assert from "node:assert";
import { it } from "node:test";
import { isSecretName, redactedSecrets } from "../src/rules/redacted-secrets.ts";
import { tester } from "./tester.ts";

it("names", () => {
  for (const name of [
    "password",
    "apiKey",
    "api_key",
    "clientSecret",
    "accessToken",
    "pin",
    "otp",
    "privateKey",
    "APIKey",
  ]) {
    assert.ok(isSecretName(name), name);
  }
  for (const name of [
    "shipping",
    "opinion",
    "keyId",
    "amount",
    "owner",
    "tokenizer",
    "spinCount",
  ]) {
    assert.ok(!isSecretName(name), name);
  }
});

tester.run("redacted-secrets", redactedSecrets, {
  valid: [
    `Domain.Command("SignIn", { input: { username: Schema.String, password: Schema.Redacted(Schema.String) } });`,
    `Schema.Struct({ apiKey: Schema.optional(Schema.Redacted(Schema.String)) });`,
    `Schema.Struct({ token: Schema.Redacted(Schema.String).pipe(Schema.brand("Token")) });`,
    // Not a schema: a runtime value.
    `const headers = { token: request.headers.token };`,
    // A custom schema alias is not seen.
    `Schema.Struct({ password: Password });`,
    `Schema.Struct({ owner: Schema.String, amount: Schema.Int });`,
    { code: `Schema.Struct({ token: Schema.String });`, options: [{ ignore: ["token"] }] },
  ],
  invalid: [
    {
      code: `Domain.Command("SignIn", { input: { password: Schema.String } });`,
      errors: [{ messageId: "redact", data: { name: "password" } }],
    },
    {
      code: `Schema.Struct({ apiKey: Schema.optional(Schema.String) });`,
      errors: [{ messageId: "redact", data: { name: "apiKey" } }],
    },
    {
      code: `class Session extends Schema.Class("Session")({ sessionToken: Schema.String.pipe(Schema.minLength(10)) }) {}`,
      errors: [{ messageId: "redact" }],
    },
    {
      code: `Schema.Struct({ iban: Schema.String });`,
      options: [{ names: ["iban"] }],
      errors: [{ messageId: "redact", data: { name: "iban" } }],
    },
  ],
});
