import type { CoreMessage } from "ai";
import type { ModelConfig } from "../ai/client";
import type { Context } from "../context";
import { Resource } from "../resource";
import { Tutorial } from "./tutorial";

/**
 * Individual tutorial configuration within a group
 */
export interface TutorialConfig {
  /**
   * The title of the tutorial
   */
  title: string;

  /**
   * The prompt to use for generating the tutorial
   */
  prompt: string;

  /**
   * The output path for the tutorial document
   */
  path: string;
}

/**
 * Properties for creating or updating a TutorialGroup
 */
export interface TutorialGroupProps {
  /**
   * List of tutorials to create within this group
   */
  tutorials: TutorialConfig[];

  /**
   * Common system prompt to prepend to all tutorial prompts
   */
  systemPrompt: string;

  /**
   * Optional difficulty level for all tutorials in this group.
   * Defaults to "beginner".
   */
  difficulty?: "beginner" | "intermediate" | "advanced";

  /**
   * Optional estimated time to complete tutorials in minutes.
   * Defaults to 30.
   */
  estimatedTime?: number;

  /**
   * Optional model configuration for generating tutorials.
   * Defaults to Claude 3.5 Sonnet.
   */
  model?: ModelConfig;

  /**
   * Initial message history for the conversation.
   * If not provided, a new conversation will be started for each tutorial.
   */
  messages?: CoreMessage[];
}

/**
 * Output returned after TutorialGroup creation/update
 */
export interface TutorialGroup
  extends Omit<TutorialGroupProps, "tutorials">,
    Resource<"docs::TutorialGroup"> {
  /**
   * Array of created Tutorial resources
   */
  tutorials: Tutorial[];

  /**
   * Time at which the tutorial group was created
   */
  createdAt: number;

  /**
   * Time at which the tutorial group was last updated
   */
  updatedAt: number;
}

/**
 * Creates a group of tutorial documents with a common system prompt and settings
 *
 * @example
 * // Create a group of basic tutorials with the same difficulty and model
 * const tutorialGroup = await TutorialGroup("getting-started-group", {
 *   systemPrompt: "All tutorials should follow the Alchemy documentation style guide.",
 *   difficulty: "beginner",
 *   estimatedTime: 30,
 *   tutorials: [
 *     {
 *       title: "Getting Started with Alchemy",
 *       prompt: "Create a tutorial for getting started with the Alchemy framework",
 *       path: "docs/tutorials/getting-started"
 *     },
 *     {
 *       title: "Building Your First Alchemy Project",
 *       prompt: "Create a tutorial for building a simple project with Alchemy",
 *       path: "docs/tutorials/first-project"
 *     }
 *   ]
 * });
 *
 * @example
 * // Create tutorials with advanced configuration
 * const advancedGroup = await TutorialGroup("advanced-group", {
 *   systemPrompt: "These tutorials should focus on advanced concepts and best practices.",
 *   difficulty: "advanced",
 *   estimatedTime: 60,
 *   model: {
 *     id: "claude-3-7-sonnet-latest",
 *     provider: "anthropic"
 *   },
 *   maxIterations: 5,
 *   tutorials: [
 *     {
 *       title: "Advanced Resource Patterns",
 *       prompt: "Create a tutorial covering advanced resource patterns in Alchemy",
 *       path: "docs/tutorials/advanced/resource-patterns"
 *     },
 *     {
 *       title: "Custom Provider Implementation",
 *       prompt: "Create a tutorial for implementing custom providers in Alchemy",
 *       path: "docs/tutorials/advanced/custom-providers"
 *     }
 *   ]
 * });
 */
export const TutorialGroup = Resource(
  "docs::TutorialGroup",
  async function (
    this: Context<TutorialGroup>,
    id: string,
    props: TutorialGroupProps
  ): Promise<TutorialGroup> {
    const {
      tutorials: tutorialConfigs,
      systemPrompt,
      difficulty = "beginner",
      estimatedTime = 30,
      model = {
        id: "claude-3-5-sonnet-latest",
        provider: "anthropic",
      },
      messages = [],
    } = props;

    console.log(
      `TutorialGroup: Starting creation of group "${id}" with ${tutorialConfigs.length} tutorials`
    );

    // Handle deletion phase
    if (this.phase === "delete") {
      console.log(`TutorialGroup: Deleting tutorial group "${id}"`);
      return this.destroy();
    }

    // Generate all tutorials
    const createdTutorials: Tutorial[] = [];
    for (const config of tutorialConfigs) {
      console.log(`TutorialGroup: Creating tutorial "${config.title}"`);

      // Combine the system prompt with the individual prompt
      const combinedPrompt = `${systemPrompt}\n\n${config.prompt}`;

      const tutorial = await Tutorial(config.title, {
        path: config.path,
        title: config.title,
        prompt: combinedPrompt,
        difficulty,
        estimatedTime,
        model,
        messages: messages.length > 0 ? [...messages] : undefined,
      });

      createdTutorials.push(tutorial);
      console.log(`TutorialGroup: Completed tutorial "${config.title}"`);
    }

    console.log(
      `TutorialGroup: Completed creation of group "${id}" with ${createdTutorials.length} tutorials`
    );

    // Return the tutorial group resource
    return this({
      ...props,
      tutorials: createdTutorials,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
);
