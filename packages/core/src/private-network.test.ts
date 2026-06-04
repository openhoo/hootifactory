import { describe, expect, test } from "bun:test";
import { isPrivateHost } from "./private-network";

describe("private network host classification", () => {
  test("detects private and non-routable host literals", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.5")).toBe(true);
    expect(isPrivateHost("172.20.0.5")).toBe(true);
    expect(isPrivateHost("192.168.1.10")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("999.1.1.1")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isPrivateHost("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateHost("[64:ff9b::169.254.169.254]")).toBe(true);
    expect(isPrivateHost("64:ff9b:1:a9fe:a9:fe00::")).toBe(true);
    expect(isPrivateHost("::a9fe:a9fe")).toBe(true);
    expect(isPrivateHost("2002:a9fe:a9fe::")).toBe(true);
    expect(isPrivateHost("fe81::1")).toBe(true);
    expect(isPrivateHost("fec0::1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
    expect(isPrivateHost("64:ff9b::0808:0808")).toBe(false);
    expect(isPrivateHost("64:ff9b:1:808:8:800::")).toBe(false);
    expect(isPrivateHost("::0808:0808")).toBe(false);
    expect(isPrivateHost("2002:0808:0808::")).toBe(false);
  });
});
