import { Schema } from "effect";

export const Runtime = Schema.Literal("pi");
export type Runtime = typeof Runtime.Type;
