import { BlockList, isIP } from 'node:net';

/**
 * Network destination policy for protocol clients the browser implements
 * itself (Gopher now; FTP, Finger and NNTP later). These clients open raw
 * TCP connections, so without this a web page could use them to reach
 * services on the user's machine or local network (server-side request
 * forgery through the browser).
 */

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64: embeds an IPv4 address
  ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], // discard, special, documentation, 6to4
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

/** True only for a literal IP address that is globally routable. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4');
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return !NON_PUBLIC.check(mapped[1]!, 'ipv4');
  if (/^::ffff:/i.test(address)) return false;
  return !NON_PUBLIC.check(address, 'ipv6');
}

/**
 * Ports that carry other protocols. A Gopher request is one attacker-chosen
 * line of text, which is enough to issue a command to many text protocols
 * (SMTP, Redis, memcached), so these are refused even on public hosts.
 * Based on the browser "bad ports" list, plus common database and cache ports.
 */
const RESTRICTED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3306, 3659, 4045, 5060, 5061, 5432, 6000, 6379, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 9200, 10080,
  11211, 27017,
]);

export function isRestrictedPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535 || RESTRICTED_PORTS.has(port);
}
