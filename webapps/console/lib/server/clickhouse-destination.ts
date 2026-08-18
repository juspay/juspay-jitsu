import type { ClickhouseCredentials } from "../schema/destinations";

type ClickhouseDestinationCredentials = Pick<ClickhouseCredentials, "hosts" | "protocol">;

/**
 * Build an HTTP-interface URL for Console's Query Data client.
 *
 * Warehouse writes may use ClickHouse's native protocols, but @clickhouse/client
 * speaks the HTTP interface. Reject native-only destination configurations with
 * an actionable error instead of attempting TLS against a native or plaintext
 * port.
 */
export function getClickhouseDestinationHttpUrl(cred: ClickhouseDestinationCredentials): string {
  let defaultPort: string;
  switch (cred.protocol) {
    case "http":
      defaultPort = "8123";
      break;
    case "https":
      defaultPort = "8443";
      break;
    case "clickhouse":
    case "clickhouse-secure":
      throw new Error(
        `Query Data supports ClickHouse HTTP protocols only; destination protocol is ${cred.protocol}. ` +
          "Configure an HTTP (8123) or HTTPS (8443) endpoint for this destination."
      );
  }

  const host = cred.hosts[0];
  if (!host) {
    throw new Error("Query Data requires at least one ClickHouse host.");
  }

  // Preserve an explicitly configured port. This also handles bracketed IPv6
  // authorities such as [::1]:8123.
  const hasPort = host.startsWith("[") ? /^\[[^\]]+\]:\d+$/.test(host) : /:\d+$/.test(host);
  const authority = hasPort ? host : `${host}:${defaultPort}`;
  return `${cred.protocol}://${authority}/`;
}
