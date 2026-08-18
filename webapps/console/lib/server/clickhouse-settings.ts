import type { ClickHouseClient, ClickHouseSettings } from "@clickhouse/client";

/**
 * Return only the requested settings exposed by the connected ClickHouse
 * server. ClickHouse adds and removes settings between releases; sending an
 * unknown setting rejects the entire query before execution.
 */
export async function getSupportedClickhouseSettings(
  clickhouse: ClickHouseClient,
  requested: ClickHouseSettings
): Promise<ClickHouseSettings> {
  const names = Object.keys(requested).filter(name => requested[name] !== undefined);
  if (names.length === 0) {
    return {};
  }

  const result = await clickhouse.query({
    query: `SELECT name FROM system.settings WHERE name IN {names:Array(String)}`,
    query_params: { names },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ name: string }>;
  const supported = new Set(rows.map(row => row.name));
  return Object.fromEntries(Object.entries(requested).filter(([name]) => supported.has(name)));
}
