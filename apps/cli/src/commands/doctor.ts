import { Command, Options } from "@effect/cli";
import { Doctor } from "@pihub/core";
import { Console, Effect } from "effect";

const jsonFlag = Options.boolean("json").pipe(
  Options.withDescription("Emit the full report as JSON (DoctorReport schema)"),
);

const statusGlyph = (status: "pass" | "fail" | "warn"): string =>
  status === "pass" ? "✓" : status === "warn" ? "!" : "✗";

export const doctorCommand = Command.make("doctor", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const doctor = yield* Doctor;
    const report = yield* doctor.run;
    if (json) {
      yield* Console.log(JSON.stringify(report, null, 2));
    } else {
      const nameWidth = Math.max(...report.checks.map((c) => c.name.length));
      for (const c of report.checks) {
        yield* Console.log(`${statusGlyph(c.status)} ${c.name.padEnd(nameWidth)}  ${c.message}`);
        if (c.details) yield* Console.log(`    ${c.details}`);
      }
      yield* Console.log("");
      yield* Console.log(report.ok ? "all checks passed" : "one or more checks failed");
    }
    if (!report.ok) process.exitCode = 1;
  }),
).pipe(Command.withDescription("Run all PiHub health checks; exit 1 if any fail"));
