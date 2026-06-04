import { isIP } from "node:net";

function parseIPv4Literal(hostname: string): number[] | null {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function expandIPv6Literal(hostname: string): number[] | null {
  if (isIP(hostname) !== 6) return null;
  let h = hostname;
  const dotted = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = parseIPv4Literal(dotted[2]!);
    if (!octets) return null;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    h = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const compressed = h.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  const explicit = [...left, ...right];
  if (explicit.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const zeros = compressed.length === 2 ? 8 - explicit.length : 0;
  if (zeros < 0 || (compressed.length === 1 && explicit.length !== 8)) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: zeros }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function ipv6Bytes(hextets: number[]): number[] {
  return hextets.flatMap((hextet) => [(hextet >> 8) & 0xff, hextet & 0xff]);
}

function bytesStartWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ipv4StringFromBytes(bytes: number[]): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function rfc6052EmbeddedIPv4(bytes: number[], prefixLength: 32 | 40 | 48 | 56 | 64 | 96): string {
  if (prefixLength === 96) return ipv4StringFromBytes(bytes.slice(12, 16));
  const withoutReservedOctet = [...bytes.slice(0, 8), ...bytes.slice(9)];
  const start = prefixLength / 8;
  return ipv4StringFromBytes(withoutReservedOctet.slice(start, start + 4));
}

function embeddedIPv4Host(hextets: number[]): string | null {
  const bytes = ipv6Bytes(hextets);
  if (bytesStartWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return ipv4StringFromBytes(bytes.slice(12, 16));
  }
  if (bytesStartWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return ipv4StringFromBytes(bytes.slice(12, 16));
  }
  if (bytesStartWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return rfc6052EmbeddedIPv4(bytes, 96);
  }
  if (bytesStartWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) {
    return rfc6052EmbeddedIPv4(bytes, 48);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return ipv4StringFromBytes(bytes.slice(2, 6));
  }
  return null;
}

/** Literal hosts that must never be fetched server-side: loopback, private, link-local, metadata, ULA, multicast, or reserved. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const looksLikeIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
  const octets = parseIPv4Literal(h);
  if (looksLikeIPv4 && !octets) return true;
  if (octets) {
    const [a, b] = [octets[0]!, octets[1]!];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  const hextets = expandIPv6Literal(h);
  if (!hextets) return false;
  const first = hextets[0]!;
  if (
    h === "::1" ||
    h === "::" ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    (first >= 0xfec0 && first <= 0xfeff) ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xff00 && first <= 0xffff)
  ) {
    return true;
  }
  const embedded = embeddedIPv4Host(hextets);
  if (embedded) return isPrivateHost(embedded);
  return false;
}
