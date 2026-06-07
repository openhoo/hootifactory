import { describe, expect, test } from "bun:test";
import type { NormalizedFinding } from "@hootifactory/scanner";
import { createTestDependencyTarget } from "@hootifactory/scanner/testing";
import {
  createMalwareStreamConsumer,
  heuristicDependencyScanner,
  heuristicMalwareScanner,
  scanDependenciesAgainstAdvisories,
  scanForMalware,
} from "./index";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EICAR_FINDING = {
  type: "malware",
  severity: "critical",
  vulnId: "EICAR-TEST",
  title: "EICAR antivirus test signature detected",
} satisfies NormalizedFinding;

describe("heuristic dependency advisories", () => {
  test("flags dependencies from the built-in advisory database", () => {
    const findings = scanDependenciesAgainstAdvisories({
      "evil-dep": "^1.2.3",
      safe: "1.0.0",
      "left-pad-vuln": "~1.0.0",
    });

    expect(findings.map((finding) => finding.vulnId)).toEqual(["HOOT-2024-0001", "HOOT-2024-0002"]);
    expect(findings[0]).toMatchObject({
      type: "vuln",
      severity: "critical",
      packageName: "evil-dep",
      packageVersion: "^1.2.3",
    });
    // A known-malicious dependency has no patched release, so no fixedVersion is reported.
    expect(findings[0]?.fixedVersion).toBeUndefined();
  });

  test("emits a purl when a purlType is provided", () => {
    const [finding] = scanDependenciesAgainstAdvisories(
      { "evil-dep": "1.0.0" },
      { purlType: "npm" },
    );
    expect(finding?.purl).toBe("pkg:npm/evil-dep@1.0.0");
  });
});

describe("heuristic malware signature", () => {
  test("detects the EICAR signature within the scanned bytes", () => {
    expect(scanForMalware(new TextEncoder().encode(`prefix ${EICAR} suffix`))).toEqual([
      EICAR_FINDING,
    ]);
    expect(scanForMalware(new TextEncoder().encode("plain package bytes"))).toEqual([]);
  });

  test("detects the EICAR signature far into the stream", () => {
    const signature = new TextEncoder().encode(EICAR);
    const bytes = new Uint8Array(8192 + signature.length);
    bytes.set(signature, 8192);
    expect(scanForMalware(bytes)).toEqual([EICAR_FINDING]);
  });

  test("detects the EICAR signature across chunk boundaries", () => {
    const consumer = createMalwareStreamConsumer();
    const split = Math.floor(EICAR.length / 2);
    consumer.update(new TextEncoder().encode(`prefix ${EICAR.slice(0, split)}`));
    expect(consumer.findings()).toEqual([]);
    consumer.update(new TextEncoder().encode(`${EICAR.slice(split)} suffix`));
    expect(consumer.findings()).toEqual([EICAR_FINDING]);
  });
});

describe("heuristic baseline scanner plugins", () => {
  test("the dependency scanner is an always-on offline baseline", async () => {
    expect(heuristicDependencyScanner.baseline).toBe(true);
    expect(heuristicDependencyScanner.capabilities.inputKind).toBe("dependencies");
    expect(
      heuristicDependencyScanner.configFromEnv({
        env: {},
        runtime: { cliRuntime: "host" },
        isProduction: false,
      }),
    ).toBeNull();
    expect(heuristicDependencyScanner.available(null, { runtime: {} })).toBe(true);

    const findings = await heuristicDependencyScanner.scanDependencies?.(
      createTestDependencyTarget({ "evil-dep": "1.0.0" }, { purlType: "npm" }),
      null,
      { runtime: {} },
    );
    expect(findings?.map((f) => f.vulnId)).toEqual(["HOOT-2024-0001"]);
    expect(findings?.[0]?.purl).toBe("pkg:npm/evil-dep@1.0.0");
  });

  test("the malware scanner is an always-on streamed baseline", () => {
    expect(heuristicMalwareScanner.baseline).toBe(true);
    expect(heuristicMalwareScanner.capabilities.inputKind).toBe("stream");
    expect(heuristicMalwareScanner.available(null, { runtime: {} })).toBe(true);
    const consumer = heuristicMalwareScanner.createStreamConsumer?.(null);
    consumer?.update(new TextEncoder().encode(`x ${EICAR} y`));
    expect(consumer?.findings()).toEqual([EICAR_FINDING]);
  });
});
