import { z } from "zod/v3";
import { SCRIPT_MULTIWORKER_DISPATCHER } from "./script.ts";

import type { Plugin } from "miniflare";
import { ProxyNodeBinding } from "miniflare";
import { MultiWorkerOptionsSchema } from "./schema.ts";

// this is coupled to miniflare internals
// packages/miniflare/src/plugins/core/constants.ts
const CORE_PLUGIN_NAME = "core";

// Service prefix for all regular user workers
const SERVICE_USER_PREFIX = `${CORE_PLUGIN_NAME}:user`;

function getUserServiceName(workerName = "") {
	return `${SERVICE_USER_PREFIX}:${workerName}`;
}

const DISPATCHER_SERVICE_NAME = "multiworker:service";

const SharedOptionsSchema = z.object({
	workers: z.array(z.object({
		name: z.string(),
		assets: z.any().optional(),
	})),
	fallbackWorker: z.string().optional(),
	allWorkers: z.set(z.string()).optional(),
	workersWithAssets: z.set(z.string()).optional(),
}).transform((sharedOptions) => {
	// 
	return {
		...sharedOptions,
		allWorkers: sharedOptions.allWorkers ?? new Set(sharedOptions.workers.map(w => w.name)),
		workersWithAssets: sharedOptions.workersWithAssets ?? new Set(sharedOptions.workers.filter(w => w.assets).map(w => w.name)),
		fallbackWorker: sharedOptions.fallbackWorker ?? sharedOptions.workers.length > 1 ? sharedOptions.workers[1].name : undefined,
	};
});

export const MULTIWORKER_PLUGIN: Plugin<
	// @ts-expect-error miniflare zod is too old to be compatible with zod/v3
	typeof MultiWorkerOptionsSchema,
	typeof SharedOptionsSchema
> = {
	options: MultiWorkerOptionsSchema,
	sharedOptions: SharedOptionsSchema,

	async getExtensions({ options }) {
		if (!options.some((o) => o.multiworkerRouting?.enabled)) {
			return [];
		}

		return [];
	},

	getPersistPath(_sharedOptions, tmpPath) {
		return tmpPath;
	},

	async getBindings(options) {
		if (!options.multiworkerRouting?.enabled) {
			return [];
		}

		return [
			{
				name: options.multiworkerRouting.dispatcherBinding,
				service: { name: DISPATCHER_SERVICE_NAME },
			},
		];
	},

	async getNodeBindings(options) {
		if (!options.multiworkerRouting?.enabled) {
			return {};
		}

		return {
			[options.multiworkerRouting.dispatcherBinding]: new ProxyNodeBinding(),
		};
	},

	async getServices({ options, workerNames, sharedOptions }) {
		if (!options.multiworkerRouting?.enabled) {
			return [];
		}

		const routing = options.multiworkerRouting;
		// cast needed because miniflare zod is too old to be compatible with zod/v3
		const globalOptions = sharedOptions as unknown as z.infer<typeof SharedOptionsSchema>;
		// the default worker is the second worker because the first worker is the dispatcher, but if there is only one worker, use the fallback worker
		const defaultWorker = globalOptions.fallbackWorker ?? workerNames.length > 1 ? workerNames[1] : globalOptions.fallbackWorker;

		const allPossibleWorkerNames = globalOptions.allWorkers.union(new Set(workerNames));

		return [
			{
				name: DISPATCHER_SERVICE_NAME,
				worker: {
					name: "dispatcher",
					compatibilityDate: "2024-01-01",
					modules: [
						{
							name: "dispatcher.mjs",
							esModule: SCRIPT_MULTIWORKER_DISPATCHER,
						},
					],
					bindings: [
						{
							name: "DEFAULT_WORKER",
							service: { name: getUserServiceName(defaultWorker) },
						},
						...allPossibleWorkerNames.values().map((workerName) => ({
							name: `WORKER_${workerName.toUpperCase()}`,
							service: {
								name: globalOptions.workersWithAssets.has(workerName)
									? `assets:rpc-proxy:${workerName}` // Assets pipeline entry - this is tightly coupled to the ASSETS plugin in miniflare
									: getUserServiceName(workerName), // Direct to user worker
							},
						})),
						{
							name: "HEADER_NAME",
							text: routing.headerName,
						},
					],
				},
			},
		];
	},
};
