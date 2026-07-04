import {
  TracePolicyViolation,
  persistTraceTelemetry,
} from "./con_trace_privacy_and_non_authority_18";

describe("trace telemetry scope authorization", () => {
  it("blocks persistence when the requested trace scope is not explicitly authorized", () => {
    expect(() =>
      persistTraceTelemetry({
        scope: "session-b",
        allowedScopes: ["session-a"],
        trace: {
          logLine: "benign telemetry from a different session",
          evaluatorScore: 0.99,
        },
      }),
    ).toThrow(TracePolicyViolation);
  });
});
