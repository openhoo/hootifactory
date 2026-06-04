import { describe, expect, test } from "bun:test";
import { RegistryWriteAdmission } from "./request-safety";

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
