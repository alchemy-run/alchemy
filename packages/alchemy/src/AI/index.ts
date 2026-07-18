/**
 * The minimal AI core: the four TERMS (pure data — `Agent`, `Process`,
 * `Tool`, `Parameter`) and the KERNEL contract (`Kernel.interpret`,
 * the `AI.layer` default Layer for agents, typed errors). The source
 * is the design: everything else is built up deliberately from this
 * base.
 */
export * from "./Actor.ts";
export * from "./Agent.ts";
export * from "./Errors.ts";
export * from "./Event.ts";
export * from "./Kernel.ts";
export * from "./Parameter.ts";
export * from "./Process.ts";
export * from "./Services.ts";
export * from "./Tool.ts";
