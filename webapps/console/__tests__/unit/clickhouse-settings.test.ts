import type { ClickHouseClient } from "@clickhouse/client";
import { describe, expect, it, vi } from "vitest";
import { getSupportedClickhouseSettings } from "../../lib/server/clickhouse-settings";

describe("getSupportedClickhouseSettings", () => {
  it("returns only settings exposed by the connected ClickHouse version", async () => {
    const json = vi.fn(async () => [{ name: "materialize_ttl_after_modify" }]);
    const query = vi.fn(async () => ({ json }));
    const clickhouse = { query } as unknown as ClickHouseClient;

    await expect(
      getSupportedClickhouseSettings(clickhouse, {
        allow_suspicious_ttl_expressions: 1,
        materialize_ttl_after_modify: 0,
      })
    ).resolves.toEqual({ materialize_ttl_after_modify: 0 });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { names: ["allow_suspicious_ttl_expressions", "materialize_ttl_after_modify"] },
      })
    );
  });

  it("does not query ClickHouse when no settings were requested", async () => {
    const query = vi.fn();
    const clickhouse = { query } as unknown as ClickHouseClient;

    await expect(getSupportedClickhouseSettings(clickhouse, {})).resolves.toEqual({});
    expect(query).not.toHaveBeenCalled();
  });
});
