import type { CoreMessage } from "ai";
import { Document } from "../ai";
import type { ModelConfig } from "../ai/client";
import { alchemy } from "../alchemy";
import type { Context } from "../context";
import type { Folder } from "../fs";
import { Resource } from "../resource";

/**
 * Properties for creating or updating a Tutorial
 */
export interface TutorialProps {
  /**
   * The output directory for the tutorial document.
   */
  path: string | Folder;

  /**
   * The title of the tutorial.
   */
  title: string;

  /**
   * The prompt to use for generating the tutorial.
   * This should include specific details about the tool or framework.
   */
  prompt: string;

  /**
   * Optional difficulty level for the tutorial.
   * Defaults to "beginner".
   */
  difficulty?: "beginner" | "intermediate" | "advanced";

  /**
   * Optional estimated time to complete the tutorial in minutes.
   * Defaults to 30.
   */
  estimatedTime?: number;

  /**
   * Optional model configuration for generating the tutorial.
   * Defaults to Claude 3.5 Sonnet.
   */
  model?: ModelConfig;

  /**
   * Initial message history for the conversation.
   * If not provided, a new conversation will be started.
   */
  messages?: CoreMessage[];
}

/**
 * Output returned after Tutorial creation/update
 */
export interface Tutorial extends TutorialProps, Resource<"docs::Tutorial"> {
  /**
   * The Document resource
   */
  document: Document;

  /**
   * The content of the tutorial
   */
  content: string;

  /**
   * Message history from the conversation.
   */
  messages: CoreMessage[];

  /**
   * Time at which the tutorial was created
   */
  createdAt: number;

  /**
   * Time at which the tutorial was last updated
   */
  updatedAt: number;
}

/**
 * Creates a tutorial document with iterative review and improvement
 *
 * @example
 * // Create a basic tutorial
 * const tutorial = await Tutorial("getting-started", {
 *   path: "docs/tutorials/getting-started",
 *   title: "Getting Started with Alchemy",
 *   prompt: "Create a tutorial for getting started with the Alchemy framework",
 *   difficulty: "beginner",
 *   estimatedTime: 30
 * });
 *
 * @example
 * // Create an advanced tutorial with custom model and continue from existing messages
 * const advancedTutorial = await Tutorial("advanced-features", {
 *   path: "docs/tutorials/advanced-features",
 *   title: "Advanced Alchemy Features",
 *   prompt: "Create a tutorial covering advanced features of the Alchemy framework",
 *   difficulty: "advanced",
 *   estimatedTime: 60,
 *   model: {
 *     id: "claude-3-7-sonnet-latest",
 *     provider: "anthropic"
 *   },
 *   maxIterations: 5,
 *   messages: basicTutorial.messages
 * });
 */
export const Tutorial = Resource(
  "docs::Tutorial",
  async function (
    this: Context<Tutorial>,
    id: string,
    props: TutorialProps
  ): Promise<Tutorial> {
    const {
      path: outFile,
      title,
      prompt,
      difficulty = "beginner",
      estimatedTime = 30,
      model = {
        id: "claude-3-5-sonnet-latest",
        provider: "anthropic",
      },
      messages: initialMessages = [],
    } = props;

    console.log(`Tutorial: Starting creation of "${title}" (ID: ${id})`);

    // Handle deletion phase
    if (this.phase === "delete") {
      console.log(`Tutorial: Deleting tutorial "${title}" (ID: ${id})`);
      return this.destroy();
    }

    // System prompts

    // Initial message if none provided
    const startingMessages =
      initialMessages.length > 0
        ? initialMessages
        : [
            {
              role: "user" as const,
              content: `Create a comprehensive tutorial about ${title}.\n\n${prompt}\n\nDifficulty level: ${difficulty}\nEstimated time to complete: ${estimatedTime} minutes`,
            },
          ];

    const tutorial = await Document(`document`, {
      title: title,
      path: typeof outFile === "string" ? outFile : outFile.path,
      model,
      messages: startingMessages,
      system:
        await alchemy`You are a technical writer creating a comprehensive tutorial.
          Your task is to create a detailed tutorial about ${title} with difficulty level: ${difficulty} and estimated time to complete: ${estimatedTime} minutes.
          The tutorial should take users from zero knowledge to a working understanding of the tool or framework.
          The tutorial should be structured as follows:
          
          # ${title}
          
          ## Overview
          
          (Provide a brief introduction to the tool/framework, its purpose, and what users will learn in this tutorial)
          
          ## Prerequisites
          
          (List any prerequisites, tools, or knowledge required before starting the tutorial)
          
          ## Setup
          
          ### Installation
          
          \`\`\`bash
          # Installation commands
          \`\`\`
          
          ### Configuration
          
          (Explain any necessary configuration steps)
          
          \`\`\`bash
          # Configuration commands or code
          \`\`\`
          
          ## Step 1: [First Step Title]
          
          (Explain the first step in detail)
          
          \`\`\`bash
          # Commands or code for the first step
          \`\`\`
          
          (Explain what the code does and why it's important)
          
          ## Step 2: [Second Step Title]
          
          (Explain the second step in detail)
          
          \`\`\`bash
          # Commands or code for the second step
          \`\`\`
          
          (Explain what the code does and why it's important)
          
          ## Step 3: [Third Step Title]
          
          (Explain the third step in detail)
          
          \`\`\`bash
          # Commands or code for the third step
          \`\`\`
          
          (Explain what the code does and why it's important)
          
          ## Step 4: [Fourth Step Title]
          
          (Explain the fourth step in detail)
          
          \`\`\`bash
          # Commands or code for the fourth step
          \`\`\`
          
          (Explain what the code does and why it's important)
          
          ## Step 5: [Fifth Step Title]
          
          (Explain the fifth step in detail)
          
          \`\`\`bash
          # Commands or code for the fifth step
          \`\`\`
          
          (Explain what the code does and why it's important)
          
          ## Testing Your Work
          
          (Explain how to verify that everything is working correctly)
          
          \`\`\`bash
          # Testing commands or code
          \`\`\`
         `,
    });

    return this({
      ...props,
      document: tutorial,
      content: tutorial.content,
      messages: tutorial.messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
);
