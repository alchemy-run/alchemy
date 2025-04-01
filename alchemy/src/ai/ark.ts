import {
  type Tool as AITool,
  type Schema,
  type ToolExecutionOptions,
  tool as aitool,
  jsonSchema,
} from "ai";
import { ArkErrors, type JsonSchema, type type } from "arktype";

export namespace ark {
  export function schema<T>(type: JsonSchema): Schema<T>;
  export function schema<T extends type>(type: T): Schema<type.infer<T>> {
    const jsonSchemaObj = type.toJsonSchema() as any;
    const processedSchema = processSchema(jsonSchemaObj);

    return jsonSchema(processedSchema, {
      validate: (value) => {
        const out = type(value) as type.infer<T> | type.errors;
        if (out instanceof ArkErrors) {
          return {
            success: false,
            error: new Error(out.summary),
          };
        }
        return {
          success: true,
          value: out,
        };
      },
    });
  }

  /**
   * Recursively processes a JSON schema and sets additionalProperties: false
   * for any object types.
   *
   * Structured Outputs requires additionalProperties: false
   */
  function processSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;

    // Create a copy to avoid mutating the original
    const result = { ...schema };

    // Convert anyOf with all const values to enum
    if (result.anyOf && Array.isArray(result.anyOf)) {
      const allConst = result.anyOf.every(
        (item: any) => item && typeof item === "object" && "const" in item,
      );

      if (allConst) {
        // Extract all const values
        const enumValues = result.anyOf.map((item: any) => item.const);

        // Determine the type based on the first const value
        // Assuming all const values are of the same type
        const firstType = typeof enumValues[0];

        // Replace anyOf with enum
        delete result.anyOf;
        result.type = firstType;
        result.enum = enumValues;
      } else {
        // Process each item in anyOf
        result.anyOf = result.anyOf.map(processSchema);
      }
    }

    // If this is an object type, set additionalProperties: false
    if (result.type === "object") {
      result.additionalProperties = false;
      result.properties ??= {};
    }

    // Process properties of objects
    if (result.properties && typeof result.properties === "object") {
      result.properties = Object.fromEntries(
        Object.entries(result.properties).map(([key, value]) => [
          key,
          processSchema(value),
        ]),
      );
    }

    // Process items in arrays
    if (result.items) {
      result.items = processSchema(result.items);
    }

    // Process allOf, oneOf
    for (const key of ["allOf", "oneOf"]) {
      if (Array.isArray(result[key])) {
        result[key] = result[key].map(processSchema);
      }
    }

    return result;
  }

  export interface Tool<Input extends type, Output>
    extends Omit<AITool<Schema<type.infer<Input>>>, "parameters" | "execute"> {
    description?: string;
    parameters: Input;
    execute: (
      input: type.infer<Input>,
      options: ToolExecutionOptions,
    ) => Promise<Output>;
  }

  export function tool<Input extends type, Output>(
    tool: Tool<Input, Output>,
  ): AITool<Schema<type.infer<Input>>, Output> {
    return aitool({
      ...tool,
      parameters: ark.schema<Input>(tool.parameters),
    } as any);
  }
}
