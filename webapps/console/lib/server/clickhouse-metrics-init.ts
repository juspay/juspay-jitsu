import type { ClickHouseClient } from "@clickhouse/client";
import { getServerLog } from "./log";

const log = getServerLog("metrics-init");

export interface MetricsInitOptions {
  clickhouse: ClickHouseClient;
  /** Database that stores Jitsu's operational metrics. */
  database: string;
  /** ClickHouse cluster name. Omit for a single-node installation. */
  cluster?: string | undefined;
}

const safeIdentifier = /^[A-Za-z0-9_-]+$/;

function quoteIdentifier(value: string, label: string): string {
  if (!value || !safeIdentifier.test(value)) {
    throw new Error(`${label} contains unsupported characters: ${value}`);
  }
  return `\`${value}\``;
}

/**
 * Create the fixed ClickHouse schema consumed by Event Statistics and active
 * event reports. Unlike customer destination tables, these objects are not
 * inferred by Bulker from event payloads.
 *
 * Every statement is CREATE IF NOT EXISTS. This function never drops,
 * truncates, or mutates customer event tables, and is safe to call on every
 * Console startup.
 */
export async function initMetricsTables(opts: MetricsInitOptions): Promise<void> {
  const database = quoteIdentifier(opts.database, "ClickHouse metrics database");
  const cluster = opts.cluster ? quoteIdentifier(opts.cluster, "ClickHouse metrics cluster") : undefined;
  const onCluster = cluster ? ` ON CLUSTER ${cluster}` : "";
  const qualified = (table: string): string => `${database}.${quoteIdentifier(table, "ClickHouse table")}`;
  const replicatedAggregatingMergeTree = (table: string): string =>
    opts.cluster
      ? `ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${opts.database}/${table}', '{replica}')`
      : "AggregatingMergeTree()";

  const createDatabase = `CREATE DATABASE IF NOT EXISTS ${database}${onCluster}`;
  try {
    await opts.clickhouse.command({ query: createDatabase });
  } catch (e: any) {
    log.atError().withCause(e).log(`Failed to create metrics database ${opts.database}`);
    throw new Error(`Failed to create ClickHouse metrics database ${opts.database}`);
  }

  const statements: Array<{ name: string; query: string }> = [
    {
      name: "active_incoming",
      query: `CREATE TABLE IF NOT EXISTS ${qualified("active_incoming")}${onCluster}
        (
          timestamp DateTime,
          workspaceId LowCardinality(String),
          messageId String
        )
        ENGINE = Null`,
    },
    {
      name: "mv_active_incoming2",
      query: `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qualified("mv_active_incoming2")}${onCluster}
        (
          workspaceId LowCardinality(String),
          timestamp DateTime,
          count AggregateFunction(uniq, String)
        )
        ENGINE = ${replicatedAggregatingMergeTree("mv_active_incoming2_0")}
        ORDER BY (workspaceId, timestamp)
        PARTITION BY toYYYYMM(timestamp)
        SETTINGS index_granularity = 8192
        AS
        SELECT
          workspaceId,
          timestamp,
          uniqState(messageId) AS count
        FROM ${qualified("active_incoming")}
        GROUP BY workspaceId, timestamp`,
    },
    {
      name: "active_incoming_agg_view",
      query: `CREATE VIEW IF NOT EXISTS ${qualified("active_incoming_agg_view")}${onCluster}
        AS
        SELECT
          timestamp,
          workspaceId,
          uniqMerge(count) AS count
        FROM ${qualified("mv_active_incoming2")}
        GROUP BY workspaceId, timestamp`,
    },
    {
      name: "metrics",
      query: `CREATE TABLE IF NOT EXISTS ${qualified("metrics")}${onCluster}
        (
          timestamp DateTime,
          messageId String,
          workspaceId LowCardinality(String),
          streamId LowCardinality(String),
          connectionId LowCardinality(String),
          functionId LowCardinality(String),
          destinationId LowCardinality(String),
          status LowCardinality(String),
          events Int64,
          eventIndex UInt32
        )
        ENGINE = Null`,
    },
    {
      name: "mv_metrics",
      query: `CREATE TABLE IF NOT EXISTS ${qualified("mv_metrics")}${onCluster}
        (
          timestamp DateTime,
          workspaceId LowCardinality(String),
          streamId LowCardinality(String),
          connectionId LowCardinality(String),
          functionId LowCardinality(String),
          destinationId LowCardinality(String),
          status LowCardinality(String),
          events AggregateFunction(sum, Int64)
        )
        ENGINE = ${replicatedAggregatingMergeTree("mv_metrics")}
        ORDER BY (timestamp, workspaceId, streamId, connectionId, functionId, destinationId, status)
        SETTINGS index_granularity = 8192`,
    },
    {
      name: "to_mv_metrics",
      query: `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qualified("to_mv_metrics")}${onCluster}
        TO ${qualified("mv_metrics")}
        AS
        SELECT
          date_trunc('minute', timestamp) AS timestamp,
          workspaceId,
          streamId,
          connectionId,
          functionId,
          destinationId,
          status,
          sumState(events) AS events
        FROM ${qualified("metrics")}
        GROUP BY timestamp, workspaceId, streamId, connectionId, functionId, destinationId, status`,
    },
  ];

  const errors: Error[] = [];
  for (const statement of statements) {
    try {
      await opts.clickhouse.command({ query: statement.query });
      log.atInfo().log(`Metrics object ${opts.database}.${statement.name} created or already exists`);
    } catch (e: any) {
      log.atError().withCause(e).log(`Failed to create metrics object ${opts.database}.${statement.name}`);
      errors.push(new Error(`Failed to create ${opts.database}.${statement.name}`));
    }
  }

  if (errors.length > 0) {
    throw new Error("Failed to initialize ClickHouse metrics: " + errors.map(e => e.message).join(", "));
  }
}
