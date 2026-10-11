import dns from "node:dns";
import net from "node:net";

// SSRF guard for web_fetch. Model-chosen URLs must not reach loopback, LAN, link-local (cloud
// metadata at 169.254.169.254) or other non-public addresses unless the operator opts in.

/** Thrown when a destination is refused. The message is safe to show the model. */
export class BlockedDestinationError extends Error {
  override name = "BlockedDestinationError";
}

type Cidr = [base: number, prefix: number];

const PRIVATE_V4: Cidr[] = [
  [ipv4ToInt("0.0.0.0"), 8], // "this network"
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // carrier-grade NAT
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], // link-local, including cloud metadata endpoints
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.0.0.0"), 24],
  [ipv4ToInt("192.0.2.0"), 24],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("198.18.0.0"), 15],
  [ipv4ToInt("198.51.100.0"), 24],
  [ipv4ToInt("203.0.113.0"), 24],
  [ipv4ToInt("224.0.0.0"), 4], // multicast
  [ipv4ToInt("240.0.0.0"), 4], // reserved, includes 255.255.255.255
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr(value: number, [base, prefix]: Cidr): boolean {
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(base / size);
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return PRIVATE_V4.some((cidr) => inCidr(value, cidr));
}

/** Expands an IPv6 address (with `::`, an embedded dotted IPv4 tail and/or a zone) to 8 groups. */
function ipv6Groups(ip: string): number[] {
  let address = ip.split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]);
    address = `${address.slice(0, dotted.index)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, tail] = address.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<number>(zeros).fill(0), ...right];
}

function embeddedV4(groups: number[]): string {
  const [hi, lo] = [groups[6], groups[7]];
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  const zeroUpTo = (n: number) => g.slice(0, n).every((group) => group === 0);
  // ::/96 covers :: (unspecified), ::1 (loopback) and deprecated IPv4-compatible addresses.
  if (zeroUpTo(6)) return true;
  // IPv4-mapped ::ffff:a.b.c.d reaches the IPv4 address itself, so classify that.
  if (zeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4(g));
  // NAT64 64:ff9b::/96 translates to the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) {
    return isPrivateV4(embeddedV4(g));
  }
  // Only 2000::/3 is allocated for global unicast. Treating everything else as private covers
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (old site-local), ff00::/8
  // (multicast), 100::/64 (discard) and any future special-purpose block, failing closed.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation (RFC 9637)
  return false;
}

/**
 * True for loopback, private, link-local, shared, documentation, multicast and other reserved
 * addresses. Anything that is not a valid IP literal also returns true, so callers fail closed.
 */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const version = net.isIP(address.split("%")[0]);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true;
}

/** Checks a URL before any connection: scheme, credentials and IP-literal hosts. */
export function assertFetchableUrl(url: URL, allowPrivate: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedDestinationError(`Only http and https URLs are allowed, not ${url.protocol}`);
  }
  if (url.username || url.password) throw new BlockedDestinationError("URLs with embedded credentials are not allowed");
  // Node skips the `lookup` hook for IP literals, so they must be classified here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
    throw new BlockedDestinationError(`Refusing to fetch a private or reserved address: ${host}`);
  }
}

/**
 * A `lookup` for http(s).request that resolves every address for the host and refuses the
 * connection if any of them is private. Because the check runs inside the connect path, the address
 * that was checked is the address that gets dialled: a DNS-rebinding answer cannot slip in between
 * a separate pre-check and the real connection.
 */
export function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, family: options.family, hints: options.hints }, (error, addresses) => {
      if (error) return callback(error, []);
      if (addresses.length === 0) return callback(new BlockedDestinationError(`No addresses found for ${hostname}`), []);
      if (!allowPrivate) {
        const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
        if (blocked) {
          return callback(
            new BlockedDestinationError(`Refusing to fetch ${hostname}: it resolves to a private or reserved address (${blocked.address})`),
            [],
          );
        }
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
