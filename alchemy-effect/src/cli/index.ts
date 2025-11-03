import * as Layer from "effect/Layer";

import { requireApproval } from "./approve.tsx";
import { reportProgress } from "./progress.tsx";

export const layer = Layer.merge(requireApproval, reportProgress);
