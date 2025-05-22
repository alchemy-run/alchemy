#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import prettier from "prettier";

const CFN_SPEC_URL =
	"https://d1uauaxba7bl26.cloudfront.net/latest/gzip/CloudFormationResourceSpecification.json";
const OUTPUT_FILE = "alchemy/src/aws/control/types.d.ts";
const PROPERTIES_FILE = "alchemy/src/aws/control/properties.ts";

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
		`  /** If true, adopt existing resource instead of failing when resource already exists */`,
	);
	lines.push(`  adopt?: boolean;`);

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

	console.log(
		"Successfully generated AWS CloudFormation type definitions and properties",
	);
} catch (error) {
	console.error("Error generating type definitions:", error);
	process.exit(1);
}
