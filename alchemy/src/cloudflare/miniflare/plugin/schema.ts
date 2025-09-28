import { z } from "zod/v3";

export const TARGET_WORKER_HEADER = "MF-target-worker";
export const MULTIWORKER_BINDING = "MULTIWORKER";

export const MultiWorkerOptionsSchema = z.object({
	multiworkerRouting: z
		.object({
			enabled: z.boolean().default(false),
            dispatcherBinding: z.literal(MULTIWORKER_BINDING).default(MULTIWORKER_BINDING),
			headerName: z.literal(TARGET_WORKER_HEADER).default(TARGET_WORKER_HEADER),
		})
		.optional(),
});

export type MultiWorkerOptions = z.input<typeof MultiWorkerOptionsSchema>;
