#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import prettier from "prettier";

const CFN_SPEC_URL =
  "https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json";
const OUTPUT_FILE = "alchemy/src/aws/control/types.d.ts";
const PROPERTIES_FILE = "alchemy/src/aws/control/properties.ts";
const DOCS_BASE_DIR = "alchemy-web/docs/providers/aws-control";

interface ResourceTypeProperty {
  Documentation?: string;
  Required?: boolean;
  Type: string;
  PrimitiveType?: string;
  PrimitiveItemType?: string;
  ItemType?: string;
  UpdateType?: string;
}

interface ResourceType {
  Documentation?: string;
  Properties: Record<string, ResourceTypeProperty>;
  Attributes?: Record<string, ResourceTypeProperty>;
}

interface CloudFormationSpec {
  ResourceTypes: Record<string, ResourceType>;
  PropertyTypes: Record<
    string,
    {
      Documentation?: string;
      Properties: Record<string, ResourceTypeProperty>;
    }
  >;
}

// Define custom type definitions that will be generated within service namespaces
const CUSTOM_TYPES: Record<string, Record<string, string>> = {
  IAM: {
    AssumeRolePolicyDocument: `{
  Version: "2012-10-17";
  Statement: Array<{
    Effect: "Allow" | "Deny";
    Principal: {
      Service?: string | string[];
      AWS?: string | string[];
      Federated?: string | string[];
      CanonicalUser?: string | string[];
    };
    Action: string | string[];
    Condition?: {
      [operator: string]: {
        [key: string]: string | string[];
      };
    };
    Sid?: string;
  }>;
}`,
  },
};

// Define manual type overrides (now just references to type names)
const TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  IAM: {
    // Override for AssumeRolePolicyDocument which is typically "json" in CFN
    AssumeRolePolicyDocument: "AssumeRolePolicyDocument",
  },
};

function convertPropertyToTypeScript(prop: ResourceTypeProperty): string {
  // Handle primitive types
  if (prop.PrimitiveType) {
    let type = prop.PrimitiveType.toLowerCase();
    if (type === "integer" || type === "double") {
      type = "number";
    } else if (type === "json") {
      type = "any";
    }
    return type;
  }
  // Handle array types
  else if (prop.Type === "List" || prop.Type === "Array") {
    if (prop.PrimitiveItemType) {
      let itemType = prop.PrimitiveItemType.toLowerCase();
      if (itemType === "integer" || itemType === "double") {
        itemType = "number";
      } else if (itemType === "json") {
        itemType = "any";
      }
      return `${itemType}[]`;
    } else if (prop.ItemType) {
      return `${sanitizeTypeName(prop.ItemType)}[]`;
    } else {
      return "any[]";
    }
  }
  // Handle map types
  else if (prop.Type === "Map") {
    return "Record<string, any>";
  }
  // Handle references to other types
  else if (prop.Type) {
    return sanitizeTypeName(prop.Type);
  }

  return "any";
}

function generatePropsInterface(
  resourceType: ResourceType,
  resourceName: string,
  serviceName: string,
): string {
  const lines: string[] = [];

  // Add interface documentation if available
  if (resourceType.Documentation) {
    lines.push(`/** ${resourceType.Documentation} */`);
  }

  lines.push(`interface ${resourceName}Props {`);

  // Add properties
  for (const [propName, prop] of Object.entries(resourceType.Properties)) {
    // Check if this property has a manual override
    const override = TYPE_OVERRIDES[serviceName]?.[propName];
    const propType = override || convertPropertyToTypeScript(prop);

    // Add documentation comment if available
    if (prop.Documentation) {
      lines.push(`  /** ${prop.Documentation} */`);
    }

    const required = prop.Required ? "" : "?";
    lines.push(`  ${propName}${required}: ${propType};`);
  }

  // Add the adopt property to all Props interfaces
  lines.push(
    "  /** If true, adopt existing resource instead of failing when resource already exists */",
  );
  lines.push("  adopt?: boolean;");

  lines.push("}");

  return lines.join("\n");
}

function generateReadOnlyPropertiesObject(
  resourceTypesByService: Record<string, Record<string, ResourceType>>,
): Record<string, Record<string, string[]>> {
  const properties: Record<string, Record<string, string[]>> = {};

  for (const [service, resources] of Object.entries(resourceTypesByService)) {
    for (const [resource, resourceType] of Object.entries(resources)) {
      const readOnlyProps: string[] = [];

      // Add all attributes (these are read-only outputs)
      if (resourceType.Attributes) {
        for (const attrName of Object.keys(resourceType.Attributes)) {
          readOnlyProps.push(attrName);
        }
      }

      // Check properties for read-only indicators
      for (const [propName, prop] of Object.entries(resourceType.Properties)) {
        // Properties with UpdateType "Immutable" are create-only (effectively read-only for updates)
        if (prop.UpdateType === "Immutable") {
          readOnlyProps.push(propName);
        }
      }

      // Only include if there are read-only properties
      if (readOnlyProps.length > 0) {
        if (!properties[service]) {
          properties[service] = {};
        }
        properties[service][resource] = readOnlyProps.sort(); // Sort for consistency
      }
    }
  }

  return properties;
}

function generateResourceType(
  resourceType: ResourceType,
  resourceName: string,
): string {
  const lines: string[] = [];

  // Add type documentation if available
  if (resourceType.Documentation) {
    lines.push(`/** ${resourceType.Documentation} */`);
  }

  lines.push(
    `type ${resourceName} = Resource<"AWS::${resourceName}"> & ${resourceName}Props & {`,
  );
  lines.push("  // Additional properties from Cloud Control API");
  lines.push("  Arn?: string;");
  lines.push("  CreationTime?: string;");
  lines.push("  LastUpdateTime?: string;");
  lines.push("};");

  return lines.join("\n");
}

function sanitizeTypeName(typeName: string | undefined): string {
  // Handle undefined or non-string inputs
  if (!typeName || typeof typeName !== "string") {
    return "any";
  }

  // Replace dots with underscores and other invalid characters
  return typeName
    .replace(/\./g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1"); // Ensure it doesn't start with a number
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeVariableName(name: string): string {
  // List of JavaScript reserved words and keywords that can't be used as variable names
  const reservedWords = new Set([
    "abstract",
    "arguments",
    "await",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "function",
    "goto",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "int",
    "interface",
    "let",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "volatile",
    "while",
    "with",
    "yield",
  ]);

  const lowerName = name.toLowerCase();

  // If it's a reserved word, prefix with "aws"
  if (reservedWords.has(lowerName)) {
    return `aws${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}`;
  }

  return lowerName;
}

function getAwsDocsUrl(service: string, _resource: string): string {
  const serviceMap: Record<string, string> = {
    EC2: "ec2",
    S3: "s3",
    IAM: "iam",
    Lambda: "lambda",
    DynamoDB: "dynamodb",
    CloudFormation: "cloudformation",
    RDS: "rds",
    ECS: "ecs",
    EKS: "eks",
    SNS: "sns",
    SQS: "sqs",
    CloudWatch: "cloudwatch",
    ElastiCache: "elasticache",
    ElasticLoadBalancing: "elasticloadbalancing",
    ElasticLoadBalancingV2: "elasticloadbalancing",
    Route53: "route53",
    CloudFront: "cloudfront",
    APIGateway: "apigateway",
    Cognito: "cognito",
    StepFunctions: "stepfunctions",
    EventBridge: "eventbridge",
    KMS: "kms",
    SecretsManager: "secretsmanager",
    Systems: "systems-manager",
    CodeBuild: "codebuild",
    CodeDeploy: "codedeploy",
    CodePipeline: "codepipeline",
  };

  const serviceName = serviceMap[service] || service.toLowerCase();
  const baseUrl = "https://docs.aws.amazon.com";

  // For most services, use the general pattern
  return `${baseUrl}/${serviceName}/latest/userguide/`;
}

async function generateMinimalExample(
  service: string,
  resource: string,
  resourceType: ResourceType,
): Promise<string> {
  const resourceVar = sanitizeVariableName(resource.toLowerCase());
  const exampleId = `${resourceVar}-example`;

  // Find required properties for the minimal example
  const requiredProps: string[] = [];
  const exampleProps: Record<string, any> = {};

  for (const [propName, prop] of Object.entries(resourceType.Properties)) {
    if (prop.Required) {
      requiredProps.push(propName);
      exampleProps[propName] = generateExampleValue(prop, propName, resource);
    }
  }

  // Add a few common optional properties for better examples
  const commonOptional = ["Tags", "Description"];
  for (const propName of commonOptional) {
    if (
      resourceType.Properties[propName] &&
      !requiredProps.includes(propName)
    ) {
      exampleProps[propName] = generateExampleValue(
        resourceType.Properties[propName],
        propName,
        resource,
      );
    }
  }

  const codeTemplate = `import AWS from "alchemy/aws/control";

const ${resourceVar} = await AWS.${service}.${resource}("${exampleId}", ${JSON.stringify(exampleProps)});`;

  const formattedCode = await prettier.format(codeTemplate, {
    parser: "typescript",
    semi: true,
    singleQuote: false,
    trailingComma: "es5",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
  });

  return `\`\`\`ts
${formattedCode.trim()}
\`\`\``;
}

function generateExampleValue(
  prop: ResourceTypeProperty,
  propName: string,
  resourceName: string,
): any {
  // Handle specific property names with better defaults
  const lowerPropName = propName.toLowerCase();
  const lowerResourceName = resourceName.toLowerCase();

  if (lowerPropName.includes("name")) {
    return `${lowerResourceName}-${lowerPropName.replace("name", "")}`;
  }

  if (lowerPropName.includes("description")) {
    return `A ${resourceName.toLowerCase()} resource managed by Alchemy`;
  }

  if (lowerPropName === "tags") {
    return {
      Environment: "production",
      ManagedBy: "Alchemy",
    };
  }

  // Handle by type
  if (prop.PrimitiveType) {
    switch (prop.PrimitiveType.toLowerCase()) {
      case "string":
        return `example-${lowerPropName}`;
      case "integer":
      case "double":
        return lowerPropName.includes("port") ? 443 : 1;
      case "boolean":
        return true;
      case "json":
        return {};
    }
  }

  if (prop.Type === "List" || prop.Type === "Array") {
    if (prop.PrimitiveItemType === "String") {
      return [`example-${lowerPropName}-1`];
    }
    return [];
  }

  if (prop.Type === "Map") {
    return {};
  }

  // Default fallback
  return `example-${lowerPropName}`;
}

async function generateSecondExample(
  service: string,
  resource: string,
  resourceType: ResourceType,
): Promise<string | null> {
  const resourceVar = sanitizeVariableName(resource.toLowerCase());

  // Generate a more advanced example with additional properties
  const exampleProps: Record<string, any> = {};
  let hasAdvancedFeatures = false;

  // Include some required properties
  for (const [propName, prop] of Object.entries(resourceType.Properties)) {
    if (prop.Required) {
      exampleProps[propName] = generateExampleValue(prop, propName, resource);
    }
  }

  // Add some interesting optional properties
  const interestingProps = [
    "Tags",
    "Description",
    "Policy",
    "Configuration",
    "Settings",
    "Encryption",
    "Monitoring",
    "Logging",
    "AccessControl",
  ];

  for (const propName of interestingProps) {
    if (resourceType.Properties[propName] && !exampleProps[propName]) {
      exampleProps[propName] = generateAdvancedExampleValue(
        resourceType.Properties[propName],
        propName,
        resource,
      );
      hasAdvancedFeatures = true;
    }
  }

  if (!hasAdvancedFeatures) {
    return null;
  }

  const codeTemplate = `import AWS from "alchemy/aws/control";

const advanced${resource} = await AWS.${service}.${resource}("advanced-${resourceVar}", ${JSON.stringify(exampleProps)});`;

  const formattedCode = await prettier.format(codeTemplate, {
    parser: "typescript",
    semi: true,
    singleQuote: false,
    trailingComma: "es5",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
  });

  return `## Advanced Configuration

Create a ${resource.toLowerCase()} with additional configuration:

\`\`\`ts
${formattedCode.trim()}
\`\`\``;
}

function generateAdvancedExampleValue(
  prop: ResourceTypeProperty,
  propName: string,
  resourceName: string,
): any {
  const lowerPropName = propName.toLowerCase();

  if (lowerPropName === "tags") {
    return {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    };
  }

  if (lowerPropName.includes("policy")) {
    return {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: "*",
        },
      ],
    };
  }

  if (lowerPropName.includes("encryption")) {
    return {
      Enabled: true,
      KmsKeyId: "alias/aws/s3",
    };
  }

  if (lowerPropName.includes("monitoring")) {
    return {
      Enabled: true,
      LoggingLevel: "INFO",
    };
  }

  // Fall back to the regular example value
  return generateExampleValue(prop, propName, resourceName);
}

async function generateResourceDocumentation(
  service: string,
  resource: string,
  resourceType: ResourceType,
): Promise<string> {
  const serviceName =
    service === "ElasticLoadBalancingV2"
      ? "Application Load Balancer"
      : service;
  const title = `Managing AWS ${serviceName} ${resource}s with Alchemy`;
  const description = `Learn how to create, update, and manage AWS ${serviceName} ${resource}s using Alchemy Cloud Control.`;
  const docsUrl = getAwsDocsUrl(service, resource);

  let content = `---
title: ${title}
description: ${description}
---

# ${resource}

The ${resource} resource lets you create and manage [AWS ${serviceName} ${resource}s](${docsUrl}) using AWS Cloud Control API.

`;

  if (resourceType.Documentation) {
    content += `${resourceType.Documentation}\n\n`;
  }

  const minimalExample = await generateMinimalExample(
    service,
    resource,
    resourceType,
  );
  content += `## Minimal Example

${minimalExample}

`;

  const secondExample = await generateSecondExample(
    service,
    resource,
    resourceType,
  );
  if (secondExample) {
    content += `${secondExample}\n\n`;
  }

  return content;
}

async function generateDocumentation(
  resourceTypesByService: Record<string, Record<string, ResourceType>>,
): Promise<void> {
  console.log("Generating documentation...");

  for (const [service, resources] of Object.entries(resourceTypesByService)) {
    const serviceDirName = toKebabCase(service);
    const serviceDir = `${DOCS_BASE_DIR}/${serviceDirName}`;

    // Create service directory
    await mkdir(serviceDir, { recursive: true });

    for (const [resource, resourceType] of Object.entries(resources)) {
      const resourceFileName = toKebabCase(resource);
      const filePath = `${serviceDir}/${resourceFileName}.md`;

      const documentation = await generateResourceDocumentation(
        service,
        resource,
        resourceType,
      );
      await writeFile(filePath, documentation);
    }
  }

  console.log("Successfully generated all documentation");
}

function generatePropertyTypeInterface(
  properties: Record<string, ResourceTypeProperty>,
  typeName: string,
): string {
  const lines: string[] = [];
  const sanitizedTypeName = sanitizeTypeName(typeName);

  lines.push(`interface ${sanitizedTypeName} {`);

  // Add properties
  for (const [propName, prop] of Object.entries(properties)) {
    // Add documentation comment if available
    if (prop.Documentation) {
      lines.push(`  /** ${prop.Documentation} */`);
    }

    const propType = convertPropertyToTypeScript(prop);
    const required = prop.Required ? "" : "?";
    lines.push(`  ${propName}${required}: ${propType};`);
  }

  lines.push("}");

  return lines.join("\n");
}

async function downloadSpec(): Promise<CloudFormationSpec> {
  console.log("Downloading CloudFormation specification...");
  const response = await fetch(CFN_SPEC_URL);

  if (!response.ok) {
    throw new Error(`Failed to download specification: ${response.statusText}`);
  }

  const spec = await response.json();

  console.log("Successfully downloaded specification");
  return spec;
}

async function generateTypes(spec: CloudFormationSpec): Promise<string> {
  console.log("Generating TypeScript types...");

  const declarations: string[] = [];
  declarations.push(`// Generated by scripts/generate-aws-control-types.ts
// DO NOT EDIT THIS FILE DIRECTLY

import type { Resource } from "../../resource.js";

declare namespace AWS {`);

  // Group property types by service for better organization
  const propertyTypesByService: Record<
    string,
    Record<
      string,
      {
        Documentation?: string;
        Properties: Record<string, ResourceTypeProperty>;
      }
    >
  > = {};

  for (const [fullTypeName, propertyType] of Object.entries(
    spec.PropertyTypes,
  )) {
    // fullTypeName is like "AWS::Cognito::UserPool.DeviceConfiguration"
    // We want to extract "Cognito" as service and "DeviceConfiguration" as type
    const nameWithoutPrefix = fullTypeName.replace("AWS::", "");
    const parts = nameWithoutPrefix.split("::");

    if (parts.length === 2) {
      const service = parts[0];
      // Split by dot to separate resource name from property type
      const typeParts = parts[1].split(".");
      const typeName = typeParts[typeParts.length - 1]; // Get the last part after the dot

      if (!propertyTypesByService[service]) {
        propertyTypesByService[service] = {};
      }
      propertyTypesByService[service][typeName] = propertyType;
    }
  }

  // Group resource types by service
  const resourceTypesByService: Record<
    string,
    Record<string, ResourceType>
  > = {};

  for (const [typeName, cfnResourceType] of Object.entries(
    spec.ResourceTypes,
  )) {
    const [service, resource] = typeName.replace("AWS::", "").split("::");
    if (!resourceTypesByService[service]) {
      resourceTypesByService[service] = {};
    }
    resourceTypesByService[service][resource] = cfnResourceType;
  }

  // Process each service
  for (const service of Object.keys({
    ...propertyTypesByService,
    ...resourceTypesByService,
  })) {
    declarations.push(`  namespace ${service} {`);

    // Generate custom type definitions for this service
    if (CUSTOM_TYPES[service]) {
      for (const [typeName, typeDefinition] of Object.entries(
        CUSTOM_TYPES[service],
      )) {
        declarations.push(`    type ${typeName} = ${typeDefinition};
`);
      }
    }

    // Generate property type interfaces for this service
    if (propertyTypesByService[service]) {
      for (const [typeName, propertyType] of Object.entries(
        propertyTypesByService[service],
      )) {
        // Skip types that have manual overrides at the top level
        if (
          TYPE_OVERRIDES[service]?.[typeName] &&
          !TYPE_OVERRIDES[service][typeName].includes(".")
        ) {
          continue;
        }

        // Pass the Properties object, not the entire PropertyType
        if (propertyType.Properties) {
          const propertyInterface = generatePropertyTypeInterface(
            propertyType.Properties,
            typeName,
          );
          declarations.push(propertyInterface);
        }
      }
    }

    // Generate resource types for this service
    if (resourceTypesByService[service]) {
      for (const [resource, cfnResourceType] of Object.entries(
        resourceTypesByService[service],
      )) {
        // Generate props interface
        const propsInterface = generatePropsInterface(
          cfnResourceType,
          resource,
          service,
        );
        declarations.push(propsInterface);

        // Generate resource type
        const resourceType = generateResourceType(cfnResourceType, resource);
        declarations.push(resourceType);

        // Add function declaration
        declarations.push(
          `    function ${resource}(id: string, props: ${resource}Props): Promise<${resource}>;`,
        );
      }
    }

    declarations.push("  }"); // Close service namespace
  }

  declarations.push("}"); // Close AWS namespace
  declarations.push("\nexport = AWS;");

  // Format the generated code with Prettier
  const unformattedCode = declarations.join("\n");
  const formattedCode = await prettier.format(unformattedCode, {
    parser: "typescript",
    semi: true,
    singleQuote: false,
    trailingComma: "es5",
    printWidth: 100,
    tabWidth: 2,
    useTabs: true,
  });

  return formattedCode;
}

async function writeTypes(types: string): Promise<void> {
  console.log(`Writing types to ${OUTPUT_FILE}...`);
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, types);
  console.log("Successfully wrote type definitions");
}

async function writeProperties(
  properties: Record<string, Record<string, string[]>>,
): Promise<void> {
  console.log(`Writing properties to ${PROPERTIES_FILE}...`);
  await mkdir(dirname(PROPERTIES_FILE), { recursive: true });

  const content = `// Generated by scripts/generate-aws-control-types.ts
// DO NOT EDIT THIS FILE DIRECTLY

// Read-only properties for AWS resources
const properties = ${JSON.stringify(properties, null, 2)};

export default properties;
`;

  await writeFile(PROPERTIES_FILE, content);
  console.log("Successfully wrote properties file");
}

try {
  const spec = await downloadSpec();
  const types = await generateTypes(spec);
  await writeTypes(types);

  // Generate read-only properties
  const resourceTypesByService: Record<
    string,
    Record<string, ResourceType>
  > = {};
  for (const [typeName, cfnResourceType] of Object.entries(
    spec.ResourceTypes,
  )) {
    const [service, resource] = typeName.replace("AWS::", "").split("::");
    if (!resourceTypesByService[service]) {
      resourceTypesByService[service] = {};
    }
    resourceTypesByService[service][resource] = cfnResourceType;
  }

  const properties = generateReadOnlyPropertiesObject(resourceTypesByService);
  await writeProperties(properties);

  // Generate documentation
  await generateDocumentation(resourceTypesByService);

  // Emit metrics
  const totalServices = Object.keys(resourceTypesByService).length;
  const totalResources = Object.values(resourceTypesByService).reduce(
    (total, serviceResources) => total + Object.keys(serviceResources).length,
    0,
  );

  console.log("\n=== AWS Cloud Control API Coverage Metrics ===");
  console.log(`Total Services: ${totalServices}`);
  console.log(`Total Resources: ${totalResources}`);

  console.log(
    "\nSuccessfully generated AWS CloudFormation type definitions, properties, and documentation",
  );
} catch (error) {
  console.error("Error generating type definitions:", error);
  process.exit(1);
}
