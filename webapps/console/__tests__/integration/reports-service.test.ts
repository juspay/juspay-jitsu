import { describe, expect, it } from "vitest";
import { deps, seedWorkspace } from "./support/harness";
import { ReportsService } from "../../lib/server/reports-service";
import { initMetricsTables } from "../../lib/server/clickhouse-metrics-init";
import { getServerEnv } from "../../lib/server/serverEnv";

// Happy paths: syncStat's source_task ⋈ ConfigurationObjectLink join on real
// Postgres, and eventStat's sumMerge aggregation through the real
// metrics → to_mv_metrics → mv_metrics materialized-view chain in ClickHouse.

const svc = () => new ReportsService({ prisma: deps().prisma, pgPool: deps().pgPool, clickhouse: deps().clickhouse });

async function seedSync(workspaceId: string) {
  const prisma = deps().prisma;
  const service = await prisma.configurationObject.create({
    data: { workspaceId, type: "service", config: { name: "src", package: "p", version: "1" } },
  });
  const destination = await prisma.configurationObject.create({
    data: { workspaceId, type: "destination", config: { name: "wh", destinationType: "webhook" } },
  });
  return prisma.configurationObjectLink.create({
    data: { workspaceId, fromId: service.id, toId: destination.id, type: "sync" },
  });
}

describe("ReportsService", () => {
  it("initializes the Event Statistics schema idempotently", async () => {
    const metricsDatabase = getServerEnv().CLICKHOUSE_METRICS_SCHEMA;
    await initMetricsTables({
      clickhouse: deps().clickhouse,
      database: metricsDatabase,
    });

    const result = await deps().clickhouse.query({
      query: `SELECT name FROM system.tables
              WHERE database = {database:String}
                AND name IN ('active_incoming', 'active_incoming_agg_view', 'mv_active_incoming2',
                             'metrics', 'mv_metrics', 'to_mv_metrics')
              ORDER BY name`,
      query_params: { database: metricsDatabase },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ name: string }>;
    expect(rows.map(row => row.name)).toEqual([
      "active_incoming",
      "active_incoming_agg_view",
      "metrics",
      "mv_active_incoming2",
      "mv_metrics",
      "to_mv_metrics",
    ]);
  });

  it("aggregates unique active events through the ClickHouse 23.8-compatible view", async () => {
    const { workspace } = await seedWorkspace();
    await deps().clickhouse.insert({
      table: "active_incoming",
      format: "JSONEachRow",
      clickhouse_settings: { wait_end_of_query: 1 },
      values: [
        { timestamp: "2026-06-10 10:00:00", workspaceId: workspace.id, messageId: "active-1" },
        { timestamp: "2026-06-10 10:00:00", workspaceId: workspace.id, messageId: "active-1" },
        { timestamp: "2026-06-10 10:00:00", workspaceId: workspace.id, messageId: "active-2" },
      ],
    });

    const result = await deps().clickhouse.query({
      query: `SELECT count FROM active_incoming_agg_view
              WHERE workspaceId = {workspaceId:String}`,
      query_params: { workspaceId: workspace.id },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ count: string }>;
    expect(rows).toEqual([{ count: "2" }]);
  });

  it("syncStat counts distinct syncs with a successful task in the period", async () => {
    const { user, workspace } = await seedWorkspace();
    const sync = await seedSync(workspace.id);
    const { workspace: foreign } = await seedWorkspace();
    const foreignSync = await seedSync(foreign.id);

    const mkTask = (syncId: string, taskId: string, status: string, startedAt: string) => ({
      sync_id: syncId,
      task_id: taskId,
      package: "p",
      version: "1",
      status,
      started_at: new Date(startedAt),
    });
    await deps().prisma.source_task.createMany({
      data: [
        mkTask(sync.id, "t1", "SUCCESS", "2026-06-10T10:00:00Z"),
        mkTask(sync.id, "t2", "SUCCESS", "2026-06-11T10:00:00Z"), // same pair — distinct keeps it at 1
        mkTask(sync.id, "t3", "FAILED", "2026-06-12T10:00:00Z"),
        mkTask(sync.id, "t4", "SUCCESS", "2026-01-01T10:00:00Z"), // outside the period
        mkTask(foreignSync.id, "t5", "SUCCESS", "2026-06-10T10:00:00Z"), // other workspace
      ],
    });

    const res = await svc().syncStat(user, workspace.id, {
      start: "2026-06-01T00:00:00Z",
      end: "2026-07-01T00:00:00Z",
    });
    expect(Number(res.activeSyncs)).toBe(1);
  });

  it("eventStat aggregates events through the mv_metrics materialized view", async () => {
    const { user, workspace } = await seedWorkspace();
    const { workspace: foreign } = await seedWorkspace();

    // Insert into the Null `metrics` table — rows materialize into mv_metrics
    // through the to_mv_metrics MV, the same path prod uses.
    const row = (messageId: string, over: Partial<Record<string, any>>) => ({
      messageId,
      workspaceId: workspace.id,
      streamId: "s1",
      connectionId: "c1",
      functionId: "",
      destinationId: "d1",
      status: "success",
      eventIndex: 0,
      ...over,
    });
    await deps().clickhouse.insert({
      table: "metrics",
      format: "JSONEachRow",
      clickhouse_settings: { wait_end_of_query: 1 },
      values: [
        // two rows, same connection/status/minute → one aggregated row with the summed count
        row("m1", { timestamp: "2026-06-10 10:00:05", events: 5 }),
        row("m2", { timestamp: "2026-06-10 10:00:30", events: 7 }),
        row("m3", { timestamp: "2026-06-10 11:00:00", status: "error", events: 1 }),
        row("m4", {
          timestamp: "2026-06-10 10:00:00",
          workspaceId: foreign.id,
          streamId: "s9",
          connectionId: "c9",
          destinationId: "d9",
          events: 100,
        }),
      ],
    });

    const res = await svc().eventStat(user, workspace.id, {
      start: "2026-06-10T00:00:00Z",
      end: "2026-06-11T00:00:00Z",
      granularity: "day",
    });
    expect(res.granularity).toBe("day");
    expect(res.rows).toHaveLength(2); // success + error for the day; the foreign row is absent
    const byStatus = Object.fromEntries(res.rows.map((r: any) => [r.status, r]));
    expect(Number(byStatus.success.events)).toBe(12); // 5 + 7 via sumMerge
    expect(Number(byStatus.error.events)).toBe(1);
    // srcSize (underlying chunk count) is part of the wire shape the UI's Report schema requires
    expect(Number(byStatus.success.srcSize)).toBeGreaterThan(0);
    expect(byStatus.success.period).toBe("2026-06-10T00:00:00Z");
    expect(byStatus.success.workspaceId).toBe(workspace.id);
  });
});
