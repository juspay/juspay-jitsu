import { describe, expect, it } from "vitest";
import { getClickhouseDestinationHttpUrl } from "../../lib/server/clickhouse-destination";

describe("getClickhouseDestinationHttpUrl", () => {
  it("uses the configured HTTP protocol and default HTTP port", () => {
    expect(getClickhouseDestinationHttpUrl({ protocol: "http", hosts: ["clickhouse.internal"] })).toBe(
      "http://clickhouse.internal:8123/"
    );
  });

  it("uses the configured HTTPS protocol and default HTTPS port", () => {
    expect(getClickhouseDestinationHttpUrl({ protocol: "https", hosts: ["clickhouse.internal"] })).toBe(
      "https://clickhouse.internal:8443/"
    );
  });

  it("preserves explicit ports and bracketed IPv6 authorities", () => {
    expect(getClickhouseDestinationHttpUrl({ protocol: "http", hosts: ["clickhouse.internal:18123"] })).toBe(
      "http://clickhouse.internal:18123/"
    );
    expect(getClickhouseDestinationHttpUrl({ protocol: "https", hosts: ["[::1]:18443"] })).toBe("https://[::1]:18443/");
  });

  it.each(["clickhouse", "clickhouse-secure"] as const)(
    "rejects the native %s protocol with an actionable error",
    protocol => {
      expect(() => getClickhouseDestinationHttpUrl({ protocol, hosts: ["clickhouse.internal"] })).toThrow(
        "Query Data supports ClickHouse HTTP protocols only"
      );
    }
  );

  it("rejects an empty host list", () => {
    expect(() => getClickhouseDestinationHttpUrl({ protocol: "http", hosts: [] })).toThrow(
      "Query Data requires at least one ClickHouse host"
    );
  });
});
