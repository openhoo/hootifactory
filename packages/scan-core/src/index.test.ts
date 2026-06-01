import { describe, expect, test } from "bun:test";
import { findingKey, maxSeverity, normalizeSeverity } from "./index";

describe("scan-core severity helpers", () => {
  test("normalizes scanner severity labels to the canonical scale", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
    expect(normalizeSeverity("moderate")).toBe("medium");
    expect(normalizeSeverity("informational")).toBe("negligible");
    expect(normalizeSeverity(undefined)).toBe("unknown");
    expect(normalizeSeverity("not-a-real-severity")).toBe("unknown");
  });

  test("selects the higher severity", () => {
    expect(maxSeverity("low", "high")).toBe("high");
    expect(maxSeverity("critical", "medium")).toBe("critical");
    expect(maxSeverity("unknown", "negligible")).toBe("negligible");
  });

  test("builds stable finding dedupe keys", () => {
    expect(
      findingKey({
        type: "vuln",
        vulnId: "CVE-1",
        purl: "pkg:npm/example@1.0.0",
        severity: "high",
      }),
    ).toBe("vuln:CVE-1:pkg:npm/example@1.0.0");

    expect(
      findingKey({ type: "malware", title: "EICAR", packageName: "payload", severity: "critical" }),
    ).toBe("malware:EICAR:payload");
  });
});
