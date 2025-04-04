import type { CoreMessage } from "ai";
import { Approve, Document, Review } from "../ai";
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
   * Maximum number of review iterations.
   * Defaults to 3.
   */
  maxIterations?: number;

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
      maxIterations = 3,
      messages: initialMessages = [],
    } = props;

    console.log(`Tutorial: Starting creation of "${title}" (ID: ${id})`);

    // Handle deletion phase
    if (this.phase === "delete") {
      console.log(`Tutorial: Deleting tutorial "${title}" (ID: ${id})`);
      return this.destroy();
    }

    // System prompts
    const docSystemPrompt = `You are a technical writer creating a comprehensive tutorial.
    
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
    
    ## Troubleshooting
    
    (Common issues users might encounter and how to resolve them)
    
    ## Next Steps
    
    (Suggest additional resources, advanced topics, or projects to try next)
    
    ## Additional Resources
    
    (Links to documentation, community resources, or related tutorials)`;

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

    // Generate the initial tutorial
    console.log(`Tutorial: Generating initial tutorial for "${title}"`);
    let tutorial = await Document(`document`, {
      title: title,
      path: typeof outFile === "string" ? outFile : outFile.path,
      model,
      messages: startingMessages,
      system: docSystemPrompt,
    });
    console.log(
      `Tutorial: Initial tutorial generated for "${title}" (${tutorial.content.length} chars)`
    );

    // Review and improve the tutorial in a loop
    let iteration = 0;
    let approved = false;
    let finalMessages = tutorial.messages;

    while (!approved && iteration < maxIterations) {
      iteration++;
      console.log(
        `Tutorial: Starting review iteration ${iteration}/${maxIterations} for "${title}"`
      );

      // Review the tutorial using system prompt
      console.log(`Tutorial: Requesting review for iteration ${iteration}`);
      const review = await Review(`review-${iteration}`, {
        messages: finalMessages,
        system:
          await alchemy`Please review this tutorial for correctness, conciseness, logical flow, and accurateness. 
        
      The tutorial should:
      1. Be technically accurate and free of errors
      2. Be concise without over-explaining
      3. Have a logical flow from basic to advanced concepts
      4. Be accurate in its descriptions and instructions
      5. Be appropriate for the ${difficulty} difficulty level
      6. Be completable within approximately ${estimatedTime} minutes
      
      Provide specific feedback on areas that need improvement.`,
        model,
      });

      // Extract the actual review content from the last assistant message
      const reviewContent =
        review.messages[review.messages.length - 1]?.content || "";
      console.log(
        `Tutorial: Review received for iteration ${iteration} (${reviewContent.length} chars)`
      );

      // Check if the tutorial is approved using system prompt
      console.log(`Tutorial: Evaluating approval for iteration ${iteration}`);
      const approvalResult = await Approve(`approval-${iteration}`, {
        messages: review.messages,
        system:
          await alchemy`Based on the review above, determine if the tutorial meets the quality standards.
      The tutorial should be approved if:
      1. It is technically accurate and free of errors
      2. It is concise without over-explaining
      3. It has a logical flow from basic to advanced concepts
      4. It is accurate in its descriptions and instructions
      5. It is appropriate for the ${difficulty} difficulty level
      6. It is completable within approximately ${estimatedTime} minutes
      
      Respond with APPROVED or DENIED, followed by your explanation.`,
      });
      console.log(
        `Tutorial: Approval result for iteration ${iteration}: ${approvalResult.approved ? "APPROVED" : "DENIED"}`
      );

      // Log approval status
      if (approvalResult.approved) {
        console.log(
          `Tutorial: Final tutorial approved: ${approvalResult.explanation}`
        );
        approved = true;
        finalMessages = approvalResult.messages;
      } else {
        console.log(
          `Tutorial: Tutorial needs improvement: ${approvalResult.explanation}`
        );

        // Add improvement request and generate an improved tutorial
        const improvementMessages = [
          ...approvalResult.messages,
          {
            role: "user" as const,
            content: `Please create an improved version of the tutorial that addresses the issues identified in the review: ${approvalResult.explanation}`,
          },
        ];

        console.log(
          `Tutorial: Regenerating tutorial based on feedback for iteration ${iteration}`
        );

        tutorial = await Document(`tutorial-${iteration}`, {
          title: title,
          path: typeof outFile === "string" ? outFile : outFile.path,
          model,
          messages: improvementMessages,
          system: docSystemPrompt,
        });
        console.log(
          `Tutorial: Improved tutorial generated for iteration ${iteration} (${tutorial.content.length} chars)`
        );

        finalMessages = tutorial.messages;
      }
    }

    if (!approved) {
      console.log(
        `Tutorial: Tutorial not approved after ${maxIterations} iterations. Using the best version available.`
      );
    }

    console.log(`Tutorial: Completed creation of "${title}" (ID: ${id})`);

    // Return the tutorial resource
    return this({
      ...props,
      document: tutorial,
      content: tutorial.content,
      messages: finalMessages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
);
