/**
 * The Typed Error Doctrine — AGENTS.md's central discipline, as a
 * PROSE-ONLY skill: the knowledge (patch paths, matcher grammar, the
 * generate command) rides the prose; the keyboard is the generic
 * ${Coding} toolbox the agent already holds. No custom tools — a patch
 * is a JSON file the agent writes, a regeneration is a shell command
 * it runs. This is the rule that made the factory compound: every red
 * test either fixes a resource or improves the SDK for the next one.
 */
import * as AI from "alchemy/AI";

export class TypedErrors extends AI.Skill<TypedErrors>()("TypedErrors") {}

/** The teaching — prose-only: no tool splices, nothing to provide. */
export const TypedErrorsLive = TypedErrors.make`
  # Growing distilled's typed error unions

  Every error an operation can produce in practice MUST be a tagged
  error in its type-level union. The catch-alls
  (\`UnknownCloudflareError\`, \`CloudflareHttpError\`, the
  out-of-union \`NotFound\`/\`BadRequest\`) exist only to SURFACE gaps
  and are never handled in alchemy code.

  When a test hits an unmatched error, the fix is ALWAYS a patch,
  never a catch.

  ## The flywheel

  1. Note the error's code, status, and message from the failure
     output.
  2. Read any existing patch at
     \`distilled/packages/cloudflare/patches/{service}/{operation}.json\`
     and MERGE — never clobber earlier tags. Add a meaningful,
     resource-specific tag (\`WidgetNotFound\`, never a bare
     \`NotFound\`):

     \`\`\`json
     { "errors": { "WidgetNotFound": [{ "code": 10404 }] } }
     \`\`\`

  3. Regenerate THAT service only, in one shell command:

     \`\`\`sh
     cd distilled/packages/cloudflare && \\
       bun scripts/generate.ts --service {service} && \\
       bun oxlint --fix src/services/{service}.ts && \\
       bun oxfmt --write src/services/{service}.ts
     \`\`\`

     The test runner resolves distilled from \`src/*.ts\` directly —
     the regenerated union is visible to the very next test run;
     never wait on a build.
  4. Handle the now-typed tag with \`Effect.catchTag\` or a typed
     retry-while and re-run the tests.

  ## Matchers

  - Combine \`"code"\`, \`"status"\`, and \`"message"\`
    (\`{ "includes": … }\`).
  - Prefer the Cloudflare error code when one exists; fall back to
    status plus a message fragment when the API misuses HTTP statuses.
  - Request-schema patch keys are camelCase; response keys are wire
    snake_case.

  ## The signal

  If a \`catchTag\` fails to typecheck, that IS the signal the union
  is missing the error — patch distilled; never loosen alchemy-side
  types, never write unknown-typed predicates, never match \`_tag\`
  strings through casts.`;
