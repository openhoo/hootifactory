import { describe, expect, mock, test } from "bun:test";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPassword } from "./breached-password";

const PASSWORD = "correct horse battery staple";

function sha1HexUpper(input: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(input);
  return hasher.digest("hex").toUpperCase();
}

const digest = sha1HexUpper(PASSWORD);
const prefix = digest.slice(0, 5);
const suffix = digest.slice(5);

function rangeResponse(lines: string[]): Response {
  return new Response(lines.join("\r\n"), { status: 200 });
}

function fetchReturning(response: Response) {
  return mock(async () => response) as unknown as typeof fetch;
}

describe("isBreachedPassword", () => {
  test("returns true when the password's suffix appears with a non-zero count", async () => {
    const doFetch = fetchReturning(
      rangeResponse(["0018A45C4D1DEF81644B54AB7F969B88D65:3", `${suffix}:1042`]),
    );
    await expect(isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch })).resolves.toBe(
      true,
    );
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  test("matches suffixes case-insensitively", async () => {
    const doFetch = fetchReturning(rangeResponse([`${suffix.toLowerCase()}:7`]));
    await expect(isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch })).resolves.toBe(
      true,
    );
  });

  test("returns false when the suffix is absent from the range response", async () => {
    const doFetch = fetchReturning(
      rangeResponse([
        "0018A45C4D1DEF81644B54AB7F969B88D65:3",
        "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2",
      ]),
    );
    await expect(isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch })).resolves.toBe(
      false,
    );
  });

  test("treats zero-count padding entries as not breached", async () => {
    const doFetch = fetchReturning(rangeResponse([`${suffix}:0`]));
    await expect(isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch })).resolves.toBe(
      false,
    );
  });

  test("sends only the five-character SHA-1 prefix with the Add-Padding header", async () => {
    let requestedUrl: string | undefined;
    let paddingHeader: string | undefined;
    const doFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requestedUrl = String(url);
      paddingHeader = (init?.headers as Record<string, string> | undefined)?.["Add-Padding"];
      return rangeResponse([]);
    }) as typeof fetch;
    await isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch });
    expect(requestedUrl).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(requestedUrl).not.toContain(suffix);
    expect(paddingHeader).toBe("true");
  });

  test("fails open on network errors and reports the failure to the caller", async () => {
    const failure = new Error("connect ECONNREFUSED");
    const doFetch = mock(async () => {
      throw failure;
    }) as unknown as typeof fetch;
    const onCheckFailure = mock((_error: unknown) => {});
    await expect(
      isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch, onCheckFailure }),
    ).resolves.toBe(false);
    expect(onCheckFailure).toHaveBeenCalledTimes(1);
    expect(onCheckFailure.mock.calls[0]?.[0]).toBe(failure);
  });

  test("fails open on non-2xx upstream responses", async () => {
    const doFetch = fetchReturning(new Response("slow down", { status: 429 }));
    const onCheckFailure = mock((_error: unknown) => {});
    await expect(
      isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch, onCheckFailure }),
    ).resolves.toBe(false);
    expect(onCheckFailure).toHaveBeenCalledTimes(1);
  });

  test("fails open when the upstream call exceeds the timeout", async () => {
    const doFetch = ((_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const onCheckFailure = mock((_error: unknown) => {});
    await expect(
      isBreachedPassword(PASSWORD, { enabled: true, fetch: doFetch, timeoutMs: 5, onCheckFailure }),
    ).resolves.toBe(false);
    expect(onCheckFailure).toHaveBeenCalledTimes(1);
  });

  test("skips the upstream call entirely when the check is disabled", async () => {
    const doFetch = mock(async () => rangeResponse([`${suffix}:1042`])) as unknown as typeof fetch;
    await expect(isBreachedPassword(PASSWORD, { enabled: false, fetch: doFetch })).resolves.toBe(
      false,
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  test("defaults to the env flag (off) when enabled is not provided", async () => {
    const doFetch = mock(async () => rangeResponse([`${suffix}:1042`])) as unknown as typeof fetch;
    await expect(isBreachedPassword(PASSWORD, { fetch: doFetch })).resolves.toBe(false);
    expect(doFetch).not.toHaveBeenCalled();
  });

  test("rejection message gives no hint of the breach count", () => {
    expect(BREACHED_PASSWORD_MESSAGE).toBe(
      "this password appears in known data breaches; choose a different one",
    );
  });
});
