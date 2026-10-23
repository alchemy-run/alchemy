import { memberPath, propertyName, unwrap } from "../ast.ts";
import type { Node, Rule } from "../types.ts";

const WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "secret",
  "token",
  "credential",
  "credentials",
  "pin",
  "otp",
  "ssn",
  "cvv",
  "cvc",
]);
const PAIRS = new Set(["apikey", "privatekey", "accesskey", "signingkey", "sessionkey"]);

/** `apiKey` → `["api", "key"]`; `client_secret` → `["client", "secret"]`. */
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

export const isSecretName = (name: string): boolean => {
  const parts = words(name);
  return (
    parts.some((part) => WORDS.has(part)) ||
    parts.some((part, i) => i > 0 && PAIRS.has(`${parts[i - 1]}${part}`)) ||
    PAIRS.has(name.toLowerCase())
  );
};

/** A value that is a schema: `Schema.String`, `Schema.optional(Schema.String)`, `Cents`... */
const schemaRoot = (node: Node | undefined): string | undefined => {
  let target = unwrap(node);
  while (target?.type === "CallExpression") {
    target = unwrap(
      target.callee.type === "MemberExpression" && memberPath(target.callee)?.at(-1) === "pipe"
        ? target.callee.object
        : target.callee,
    );
  }
  return memberPath(target)?.[0];
};

/**
 * SKILL.md: "Make secrets `Schema.Redacted`, so they never reach a trace or a log."
 *
 * A schema field named like a secret (`password`, `apiKey`, `token`,
 * `clientSecret`, `pin`, `otp`, ...) whose value is a `Schema.*` schema must
 * use `Schema.Redacted`. Only the field name is known without types, so a
 * secret behind a custom schema alias is not seen; the names are configurable.
 */
export const redactedSecrets: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Secret fields are `Schema.Redacted`." },
    messages: {
      redact:
        "`{{name}}` looks like a secret but is not `Schema.Redacted`. Wrap it (`Schema.Redacted(Schema.String)`), so it never reaches a trace or a log.",
    },
    schema: [
      {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          ignore: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = (context.options[0] ?? {}) as {
      names?: ReadonlyArray<string>;
      ignore?: ReadonlyArray<string>;
    };
    const extra = new Set((options.names ?? []).map((name) => name.toLowerCase()));
    const ignore = new Set(options.ignore ?? []);
    return {
      Property(node) {
        const name = propertyName(node);
        if (name === undefined || ignore.has(name)) return;
        if (!isSecretName(name) && !extra.has(name.toLowerCase())) return;
        if (schemaRoot(node.value) !== "Schema") return;
        const text = context.sourceCode.text.slice(node.value.start, node.value.end);
        if (/\bRedacted\b/.test(text)) return;
        context.report({ node, messageId: "redact", data: { name } });
      },
    };
  },
};
