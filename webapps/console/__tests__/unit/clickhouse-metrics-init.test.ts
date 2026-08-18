import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { initMetricsTables } from "../../lib/server/clickhouse-metrics-init";

function fakeClient() {
  const command = vi.fn(async (_args: { query: string }) => ({ query_id: "test" }));
  return { client: { command } as unknown as ClickHouseClient, command };
}

describe("initMetricsTables", () => {
  it("creates only idempotent metrics objects with cluster-aware replicated aggregates", async () => {
    const { client, command } = fakeClient();

    await initMetricsTables({ clickhouse: client, database: "newjitsu_metrics", cluster: "clickhouse-v4" });

    const queries = command.mock.calls.map(([args]) => args.query);
    expect(queries).toHaveLength(7);
    expect(queries.every(query => query.includes("IF NOT EXISTS"))).toBe(true);
    expect(queries.every(query => query.includes("ON CLUSTER `clickhouse-v4`"))).toBe(true);
    expect(queries.join("\n")).toContain("ReplicatedAggregatingMergeTree");
    expect(queries.join("\n")).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
    expect(queries.join("\n")).not.toContain("jitsu_events");
    expect(queries.join("\n")).not.toContain("REFRESH EVERY");
  });

  it("uses non-replicated engines when no cluster is configured", async () => {
    const { client, command } = fakeClient();

    await initMetricsTables({ clickhouse: client, database: "metrics_test" });

    const ddl = command.mock.calls.map(([args]) => args.query).join("\n");
    expect(ddl).not.toContain("ON CLUSTER");
    expect(ddl).toContain("ENGINE = AggregatingMergeTree()");
    expect(ddl).not.toContain("ReplicatedAggregatingMergeTree");
  });

  it("rejects unsafe database and cluster identifiers before executing DDL", async () => {
    const { client, command } = fakeClient();

    await expect(
      initMetricsTables({ clickhouse: client, database: "newjitsu_metrics; DROP DATABASE default" })
    ).rejects.toThrow("ClickHouse metrics database contains unsupported characters");
    await expect(
      initMetricsTables({ clickhouse: client, database: "newjitsu_metrics", cluster: "cluster`bad" })
    ).rejects.toThrow("ClickHouse metrics cluster contains unsupported characters");
    expect(command).not.toHaveBeenCalled();
  });
});
