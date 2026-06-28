import { createDefine } from "fresh";

// Type of `ctx.state`, shared across middleware, layouts and routes.
// Empty for now — Increment 1 carries no shared request state.
export type State = Record<string, unknown>;

export const define = createDefine<State>();
