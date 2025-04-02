import { generateText } from "ai";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import { ignore } from "../util/ignore";
import { type ModelConfig, createModel } from "./client";

/**
 * Properties for creating or updating a Document
 */
export interface DocumentProps {
  /**
   * Title of the document
   */
  title: string;

  /**
   * Path to the markdown document
   */
  path: string;

  /**
   * Base URL for the OpenAI API
   * @default 'https://api.openai.com/v1'
   */
  baseURL?: string;

  /**
   * Prompt for generating content
   * Use alchemy template literals to include file context:
   * @example
   * prompt: await alchemy`
   *   Generate docs using:
   *   ${alchemy.file("src/api.ts")}
   * `
   */
  prompt: string;

  /**
   * OpenAI API key to use for generating content
   * If not provided, will use OPENAI_API_KEY environment variable
   */
  apiKey?: Secret;

  /**
   * Model configuration
   */
  model?: ModelConfig;

  /**
   * Temperature for controlling randomness in generation.
   * Higher values (e.g., 0.8) make output more random,
   * lower values (e.g., 0.2) make it more deterministic.
   * @default 0.7
   */
  temperature?: number;
}

/**
 * A markdown document that can be created, updated, and deleted
 */
export interface Document extends DocumentProps, Resource<"docs::Document"> {
  /**
   * Content of the document
   */
  content: string;

  /**
   * Time at which the document was created
   */
  createdAt: number;

  /**
   * Time at which the document was last updated
   */
  updatedAt: number;
}

/**
 * Resource for managing AI-generated markdown documents using the Vercel AI SDK.
 * Supports powerful context handling through the alchemy template literal tag.
 *
 * @example
 * // Create a document using alchemy template literals for context
 * const apiDocs = await Document("api-docs", {
 *   title: "API Documentation",
 *   path: "./docs/api.md",
 *   prompt: await alchemy`
 *     Generate API documentation based on these source files:
 *     ${alchemy.file("src/api.ts")}
 *     ${alchemy.file("src/types.ts")}
 *   `,
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   }
 * });
 *
 * @example
 * // Use alchemy template literals with file collections and temperature control
 * const modelDocs = await Document("models", {
 *   title: "Data Models",
 *   path: "./docs/models.md",
 *   prompt: await alchemy`
 *     Write documentation for these data models:
 *     ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
 *   `,
 *   temperature: 0.2 // Lower temperature for more deterministic output
 * });
 *
 * @example
 * // Advanced model configuration with custom provider options
 * const techDocs = await Document("tech-specs", {
 *   title: "Technical Specifications",
 *   path: "./docs/tech-specs.md",
 *   prompt: await alchemy`
 *     Create detailed technical specifications based on these requirements:
 *     ${alchemy.file("requirements/system.md")}
 *   `,
 *   model: {
 *     id: "o3-mini",
 *     provider: "openai",
 *     options: {
 *       reasoningEffort: "high"
 *     }
 *   },
 *   temperature: 0.1
 * });
 */
export const Document = Resource(
  "docs::Document",
  async function (
    this: Context<Document>,
    id: string,
    props: DocumentProps,
  ): Promise<Document> {
    // Ensure directory exists
    await fs.mkdir(path.dirname(props.path), { recursive: true });

    if (this.phase === "delete") {
      try {
        await fs.unlink(props.path);
      } catch (error: any) {
        // Ignore if file doesn't exist
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return this.destroy();
    }

    // Initialize OpenAI compatible provider using shared client

    // Generate content
    const { text } = await generateText({
      model: createModel(props),
      prompt: props.prompt,
      providerOptions: props.model?.options,
      ...(props.temperature === undefined
        ? {}
        : // some models error if you provide it (rather than ignoring it)
          { temperature: props.temperature }),
    });

    if (this.phase === "update" && props.path !== this.props.path) {
      await ignore("ENOENT", () => fs.unlink(this.props.path));
    }

    // Write content to file
    await fs.writeFile(props.path, text);

    // Get file stats for timestamps
    const stats = await fs.stat(props.path);

    // Return the resource
    return this({
      ...props,
      content: text,
      createdAt: stats.birthtimeMs,
      updatedAt: stats.mtimeMs,
    });
  },
);
