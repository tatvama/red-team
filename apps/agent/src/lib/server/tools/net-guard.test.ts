// @vitest-environment node
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { assertFetchableUrl, guardedLookup, isPrivateAddress } from "./net-guard";

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::10.0.0.1",
    "64:ff9b::7f00:1",
    "::127.0.0.1",
    "100::1",
    "fe00::1",
    "3fff::1",
    "4000::1",
    "not-an-ip",
    "",
    "localhost",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.1.1",
    "192.167.255.255",
    "192.169.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "203.0.114.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:db9::1",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
  ])("treats %s as public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertFetchableUrl", () => {
  it("refuses private IP literals, other schemes and credentials", () => {
    for (const url of ["http://127.0.0.1:8080/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://169.254.169.254/latest/meta-data"]) {
      expect(() => assertFetchableUrl(new URL(url), false), url).toThrow("private or reserved");
    }
    expect(() => assertFetchableUrl(new URL("file:///etc/passwd"), false)).toThrow("Only http and https");
    expect(() => assertFetchableUrl(new URL("https://user:pw@example.com/"), false)).toThrow("credentials");
  });

  it("allows public hosts, and private literals only when opted in", () => {
    expect(() => assertFetchableUrl(new URL("https://example.com/"), false)).not.toThrow();
    expect(() => assertFetchableUrl(new URL("http://8.8.8.8/"), false)).not.toThrow();
    expect(() => assertFetchableUrl(new URL("http://127.0.0.1/"), true)).not.toThrow();
  });
});

describe("guardedLookup", () => {
  const lookup = (allowPrivate: boolean, host: string) =>
    new Promise<{ error: Error | null; addresses: unknown }>((resolve) => {
      guardedLookup(allowPrivate)(host, { all: true }, (error, addresses) => resolve({ error, addresses }));
    });

  it("refuses hosts that resolve to private addresses", async () => {
    const { error } = await lookup(false, "localhost");
    expect(error?.message).toContain("private or reserved");
  });

  it("returns every address when allowed, in the shape the HTTP client asked for", async () => {
    const all = await lookup(true, "localhost");
    expect(all.error).toBeNull();
    expect((all.addresses as LookupAddress[]).length).toBeGreaterThan(0);
    const single = await new Promise<{ address: unknown; family: unknown }>((resolve) => {
      guardedLookup(true)("localhost", {}, (_error, address, family) => resolve({ address, family }));
    });
    expect(typeof single.address).toBe("string");
    expect([4, 6]).toContain(single.family);
  });
});
