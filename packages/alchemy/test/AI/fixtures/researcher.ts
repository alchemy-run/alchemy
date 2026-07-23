/**
 * The kernel test org: ONE agent, ONE tool, ONE parameter — the
 * smallest charter that exercises every seam of the loop (system
 * prompt from prose, tool schema from parameter splices, tool physics
 * from a Layer).
 *
 * Declarations are bare tags; behavior lives in the CHARTERS exported
 * alongside them — the tests hand `Kernel.interpret(Researcher,
 * ResearcherCharter)` the pair `Researcher.make(ResearcherCharter)`
 * would.
 */
import * as AI from "@/AI/index.ts";
import * as S from "effect/Schema";

export const query = AI.Parameter("query", S.String)`
The search query.`;

export class Search extends AI.Tool<Search>()("search")`
Search the corpus for ${query}. Cheap — search before you answer.` {}

export class Researcher extends AI.Agent<Researcher>()("Researcher") {}

export const ResearcherCharter = AI.prose`
You are a careful researcher. Answer the question you are given,
using ${Search} for anything you do not already know.`;

/**
 * A skill bundling the Search tool behind how-to prose — DORMANT
 * until the agent activates it (or hands it to a spawn). The
 * declaration is a bare tag; the TEACHING lives on the Layer, so the
 * charter's requirement is the SKILL's tag and the tool tags surface
 * as {@link ArchivesLive}'s own requirements.
 */
export class Archives extends AI.Skill<Archives>()("Archives") {}

export const ArchivesLive = Archives.make`
Searching the historical archives: use ${Search} with precise
queries, one fact per query, and cite what you find.`;

export class Scholar extends AI.Agent<Scholar>()("Scholar") {}

export const ScholarCharter = AI.prose`
You answer questions with evidence. For historical questions, use
${Archives}.`;
