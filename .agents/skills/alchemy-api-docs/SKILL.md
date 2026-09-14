---
name: alchemy-api-docs
description: Generate Alchemy API documentation from source JSDoc.
---

# Alchemy Api Docs

## When to use

Load before adding or changing resource, binding, layer, or provider API documentation.

# Documentation Generation

**Source of truth:** The source code is the single source of truth for all API documentation. JSDoc comments in `packages/alchemy/src/**/*.ts` are extracted and used to generate the public API reference markdown.

:::warning
**Never edit the generated markdown files** under `website/src/content/docs/providers/{Cloud}/`. They are overwritten on every regeneration.

To "update the docs", edit the JSDoc on the source `.ts` file (resource-level JSDoc on the exported `const`, plus field-level JSDoc on each prop/attribute) and re-run the generator. There is no separate doc file to update.
:::

**How to generate docs:**

```sh
pnpm docs:gen   # -> website/src/content/docs/providers/{Cloud}/{Resource}.md
```

This is the only doc generator that produces user-facing output. ([scripts/generate-api-reference.ts](../../../scripts/generate-api-reference.ts)) does the following:

1. Discovers documented files across its configured source roots — `packages/alchemy/src/{Cloud}/{Service}/` plus flat single-provider packages like `packages/better-auth/src/` (mapped onto a synthetic provider directory, e.g. `BetterAuth/`)
2. Parses TypeScript with the native TypeScript API (`typescript-api` tooling alias)
3. Extracts the page-level summary plus Markdown section/example blocks from JSDoc on the export tagged `@resource`, `@binding`, or `@layer`
4. Writes one markdown file per page at `website/src/content/docs/providers/{Provider}/{Name}.md`

**Layer pages** (`@layer`) document exported Layer factories — the pluggable implementations of a Context service (e.g. better-auth's database layers). Alongside the shared tags, a Layer declares what it satisfies and needs:

```typescript
/**
 * Neon database layer for Better Auth over Neon's serverless driver.
 *
 * ### Connecting from a Worker or Lambda
 * **Example:** Worker or Lambda with Neon-backed Better Auth
 * ```typescript
 * // ...
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @peer @neondatabase/serverless
 * @product Neon
 */
export const Neon = (url: ConnectionSource, options?: NeonOptions): Layer.Layer<Database> => ...
```

- `@provides <Service.Tag>` — the Context service tag(s) the Layer satisfies (repeatable)
- `@peer <package>` — optional peer dependencies the Layer needs at runtime (repeatable)

Both render as a metadata line under the page's `Source:` blockquote. Every Layer implementation should carry these annotations — a Layer without them is an undocumented integration surface.

Keep all API-generator metadata tags (`@resource`, `@binding`, `@layer`,
`@product`, `@category`, `@provides`, and `@peer`) together at the very end of
the JSDoc block. Do not put prose, sections, or examples after them: TypeScript
treats subsequent content as part of the block tag, which breaks editor JSDoc
rendering. The generator also supports `@group` as an alias for `@category` and
`@label` as an alias for `@product`.

After editing JSDoc on a resource, run `pnpm docs:gen` to refresh the website
docs. Run `pnpm docs:check-jsdoc` to validate the source layout, or
`pnpm docs:fix-jsdoc` to normalize it automatically.

**Writing good documentation:** When adding or updating a resource, ensure all Props and Attrs have JSDoc comments:

```typescript
export interface BucketProps {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * Must be lowercase and between 3-63 characters.
   */
  bucketName?: string;

  /**
   * Whether to delete all objects when the bucket is destroyed.
   * @default false
   */
  forceDestroy?: boolean;
}
```

The `@default` tag is used to document default values and will appear in the generated documentation.

### Examples and Sections (IMPORTANT)

**Examples are critical for documentation.** Every resource should have examples demonstrating common use cases. Use Markdown headings and labels on the main Resource export to organize examples into a navigable table of contents.

**Format:**

- `### <Section Title>` - Creates a heading in the Examples section and adds an entry to the Quick Reference table of contents
- `**Example:** <Example Title>` - Creates a labeled code example (must follow a section heading)
- A level-three heading that is ordinary page prose rather than an example section must end with `<!-- api-prose -->`; the generator removes the marker and preserves it as `###` in the output
- Code blocks inside examples use standard markdown fenced code blocks (` `)
- Put the API-generator metadata tags after all sections and examples

**Example:**

````typescript
/**
 * An S3 bucket for storing objects.
 *
 * ### Creating a Bucket
 * **Example:** Basic Bucket
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {});
 * ```
 *
 * **Example:** Bucket with Force Destroy
 * ```typescript
 * const bucket = yield* Bucket("my-bucket", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Reading Objects
 * **Example:** Get Object from Bucket
 * ```typescript
 * const response = yield* getObject(bucket, { key: "my-key" });
 * const body = yield* Effect.tryPromise(() => response.Body?.transformToString());
 * ```
 *
 * ### Writing Objects
 * **Example:** Put Object to Bucket
 * ```typescript
 * yield* putObject(bucket, {
 *   key: "hello.txt",
 *   body: "Hello, World!",
 *   contentType: "text/plain",
 * });
 * ```
 *
 * @resource
 */
export const Bucket = Resource<...>("AWS.S3.Bucket");
````

This generates:

1. A "Quick Reference" section with links to each `###` section
2. An "Examples" section with organized code examples under each section heading

**Best practices for examples:**

- Start with the simplest use case and progress to more complex ones
- Include examples for all major capabilities (GetObject, PutObject, etc.)
- Show real-world patterns like error handling, combining with other resources
- Use descriptive titles that explain what the example demonstrates


11. Add the resource-level JSDoc (`###` section headings + `**Example:**` labels, with generator metadata tags last) and field-level JSDoc on each prop/attribute on the source `.ts` file. Run `pnpm docs:check-jsdoc`, then `pnpm docs:gen` to refresh `website/src/content/docs/providers/{Cloud}/{Resource}.md`. Do NOT manually edit the generated markdown.
