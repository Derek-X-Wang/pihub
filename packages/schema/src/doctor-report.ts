import { Schema } from "effect";

export const DoctorStatus = Schema.Literal("pass", "fail", "warn");
export type DoctorStatus = typeof DoctorStatus.Type;

export const DoctorCheck = Schema.Struct({
  name: Schema.String,
  status: DoctorStatus,
  message: Schema.String,
  details: Schema.optional(Schema.String),
});
export type DoctorCheck = typeof DoctorCheck.Type;

/**
 * Output of `pihub doctor`. `ok === true` iff every check is pass or warn —
 * the CLI exits 1 when `ok === false`. `--json` emits this verbatim.
 */
export const DoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Array(DoctorCheck),
});
export type DoctorReport = typeof DoctorReport.Type;
