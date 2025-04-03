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
   * System prompt for the model
   * This is used to provide instructions to the model about how to format the response
   * The default system prompt instructs the model to return a single markdown document inside ```md fences
   * @default "You are a technical documentation writer. Create a single markdown document based on the user's requirements. Your response MUST include only a single markdown document inside ```md fences. Do not include any other text, explanations, or multiple code blocks."
   */
  system?: string;

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
 * Default system prompt for markdown document generation
 */
const DEFAULT_MD_SYSTEM_PROMPT =
  "You are a technical documentation writer. Create a single markdown document based on the user's requirements. Your response MUST include only a single markdown document inside ```md fences. Do not include any other text, explanations, or multiple code blocks.";

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
 * // Advanced model configuration with custom provider options and custom system prompt
 * const techDocs = await Document("tech-specs", {
 *   title: "Technical Specifications",
 *   path: "./docs/tech-specs.md",
 *   prompt: await alchemy`
 *     Create detailed technical specifications based on these requirements:
 *     ${alchemy.file("requirements/system.md")}
 *   `,
 *   system: "You are an expert technical writer specializing in system specifications. Create a single markdown document inside ```md fences with no additional text.",
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

    // Use provided system prompt or default
    const system = props.system || DEFAULT_MD_SYSTEM_PROMPT;

    // Generate initial content
    const { text } = await generateText({
      model: createModel(props),
      prompt: props.prompt,
      system,
      providerOptions: props.model?.options,
      ...(props.temperature === undefined
        ? {}
        : // some models error if you provide it (rather than ignoring it)
          { temperature: props.temperature }),
    });

    // Extract and validate markdown content
    let { content, error } = await extractMarkdownContent(text);

    // Re-prompt if there are validation errors
    if (error) {
      const errorSystem = `${system}\n\nERROR: ${error}\n\nPlease try again and ensure your response contains exactly one markdown document inside \`\`\`md fences.`;

      const { text: retryText } = await generateText({
        model: createModel(props),
        prompt: props.prompt,
        system: errorSystem,
        providerOptions: props.model?.options,
        ...(props.temperature === undefined
          ? {}
          : { temperature: props.temperature }),
      });

      const retryResult = await extractMarkdownContent(retryText);

      if (retryResult.error) {
        throw new Error(
          `Failed to generate valid markdown content: ${retryResult.error}`,
        );
      }

      content = retryResult.content;
    }

    if (this.phase === "update" && props.path !== this.props.path) {
      await ignore("ENOENT", () => fs.unlink(this.props.path));
    }

    // Write content to file
    await fs.writeFile(props.path, content);

    // Get file stats for timestamps
    const stats = await fs.stat(props.path);

    // Return the resource
    return this({
      ...props,
      content: content,
      createdAt: stats.birthtimeMs,
      updatedAt: stats.mtimeMs,
    });
  },
);

/**
 * Extracts markdown content from between ```md fences
 * Validates that exactly one markdown code block exists
 *
 * @param text The text to extract markdown content from
 * @returns The extracted markdown content or error message
 */
async function extractMarkdownContent(
  text: string,
): Promise<{ content: string; error?: string }> {
  const mdCodeRegex = /```md\s*([\s\S]*?)```/g;
  const matches = Array.from(text.matchAll(mdCodeRegex));

  if (matches.length === 0) {
    return {
      content: "",
      error:
        "No markdown code block found in the response. Please include your markdown content within ```md fences.",
    };
  }

  if (matches.length > 1) {
    return {
      content: "",
      error:
        "Multiple markdown code blocks found in the response. Please provide exactly one markdown block within ```md fences.",
    };
  }

  return { content: matches[0][1].trim() };
}
