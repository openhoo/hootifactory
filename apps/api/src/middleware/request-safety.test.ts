import { describe, expect, test } from "bun:test";
import { buildTrustedOrigins, RegistryWriteAdmission } from "./request-safety";

describe("registry write admission", () => {
  test("bounds concurrent reserved bytes and releases reservations once", () => {
    const admission = new RegistryWriteAdmission(10);
    const first = admission.tryAcquire(6);
    expect(typeof first).toBe("function");
    expect(admission.currentBytes).toBe(6);

    expect(admission.tryAcquire(5)).toBeNull();
    const second = admission.tryAcquire(4);
    expect(typeof second).toBe("function");
    expect(admission.currentBytes).toBe(10);

    second?.();
    expect(admission.currentBytes).toBe(6);
    first?.();
    first?.();
    expect(admission.currentBytes).toBe(0);
  });

  test("rejects reservations larger than the total budget", () => {
    const admission = new RegistryWriteAdmission(10);
    expect(admission.tryAcquire(11)).toBeNull();
    expect(admission.currentBytes).toBe(0);
  });
});

describe("buildTrustedOrigins", () => {
  const config = {
    trusted: ["https://ci.example"],
    registryPublicUrl: "http://localhost:3000",
    appPublicUrl: "http://localhost:5173",
  };

  test("trusts the web app's own public URL (first-party session writes)", () => {
    // Request arrives at the API origin; the browser sends the web app origin.
    const origins = buildTrustedOrigins("http://localhost:3000/api/orgs", config);
    expect(origins.has("http://localhost:5173")).toBe(true);
  });

  test("trusts configured origins, the request origin, and the registry URL", () => {
    const origins = buildTrustedOrigins("http://127.0.0.1:3100/api/orgs", config);
    expect(origins.has("https://ci.example")).toBe(true);
    expect(origins.has("http://127.0.0.1:3100")).toBe(true);
    expect(origins.has("http://localhost:3000")).toBe(true);
  });

  test("does not trust unrelated origins", () => {
    const origins = buildTrustedOrigins("http://localhost:3000/api/orgs", config);
    expect(origins.has("https://attacker.example")).toBe(false);
  });
});
