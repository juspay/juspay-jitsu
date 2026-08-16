import { getLog, requireDefined } from "juava";
import { GeoResolver } from "./maxmind";
import { IngestMessage } from "@jitsu/protocols/async-request";
import { CONNECTION_IDS_HEADER } from "./rotor";
import { AnalyticsServerEvent } from "@jitsu/protocols/analytics";
import { EventContext, TTLStore } from "@jitsu/protocols/functions";
import {
  MetricsMeta,
  parseUserAgent,
  EventsStore,
  EntityStore,
  EnrichedConnectionConfig,
  FunctionConfig,
  RotorMetrics,
  StreamWithDestinations,
} from "@jitsu/destination-functions";
import NodeCache from "node-cache";
import { buildFunctionChain, checkError, FuncChain, FuncChainFilter, runChain } from "./functions-chain";
import { Redis } from "ioredis";
import { fromJitsuClassic } from "@jitsu/functions-lib";
import { mongoAnonymousEventsStore } from "./mongodb";
import { getServerEnv } from "../serverEnv";
const log = getLog("rotor");
const operatorlessConnectionsWarned = new Set<string>();

const anonymousEventsStore = mongoAnonymousEventsStore();

//cache function chains for 1m
const funcsChainTTL = 60;
const funcsChainCache = new NodeCache({ stdTTL: funcsChainTTL, checkperiod: 60, useClones: false });

export type MessageHandlerContext = {
  connectionStore: EntityStore<EnrichedConnectionConfig>;
  functionsStore: EntityStore<FunctionConfig>;
  streamsStore: EntityStore<StreamWithDestinations>;
  eventsLogger: EventsStore;
  metrics?: RotorMetrics;
  geoResolver?: GeoResolver;
  dummyPersistentStore?: TTLStore;
  redisClient?: Redis;
};

export function functionFilter(errorFunctionId?: string) {
  let runFuncs: FuncChainFilter = "all";
  const fid = errorFunctionId || "";
  if (fid.startsWith("udf.")) {
    runFuncs = "udf-n-dst";
  } else if (fid.startsWith("builtin.destination.")) {
    runFuncs = "dst-only";
  }
  return runFuncs;
}

export async function rotorMessageHandler(
  message: IngestMessage,
  rotorContext: MessageHandlerContext,
  runFuncs: FuncChainFilter = "all",
  headers?,
  retriesEnabled: boolean = true,
  retries: number = 0,
  fetchTimeoutMs: number = 2000
) {
  const serverEnv = getServerEnv();
  if (!message) {
    return;
  }
  const connStore = rotorContext.connectionStore;
  const streamsStore = rotorContext.streamsStore;

  const connectionId =
    headers && headers[CONNECTION_IDS_HEADER] ? headers[CONNECTION_IDS_HEADER].toString() : message.connectionId;
  const connection = requireDefined(connStore.getObject(connectionId), `Unknown connection: ${connectionId}`);

  log.inDebug(l =>
    l.log(
      `Processing ${message.type} Message ID: ${message.messageId} for: ${connection.id} (${connection.streamId} → ${connection.destinationId}(${connection.type}))`
    )
  );

  const event = (
    message.origin?.classic && retries === 0 ? fromJitsuClassic(message.httpPayload) : message.httpPayload
  ) as AnalyticsServerEvent;

  if (!event.context) {
    event.context = {};
  }
  const geo =
    Object.keys(event.context.geo || {}).length > 0
      ? event.context.geo
      : rotorContext.geoResolver && event.context.ip
      ? await rotorContext.geoResolver.resolve(event.context.ip)
      : undefined;
  if (geo) {
    event.context.geo = geo;
  }
  const ctx: EventContext = {
    receivedAt: new Date(message.messageCreated),
    headers: message.httpHeaders,
    geo: geo,
    ua: parseUserAgent(event.context.userAgent),
    retries,
    source: {
      type: message.ingestType,
      id: message.origin?.sourceId || connection.streamId,
      name: message.origin?.sourceName || connection.streamName,
      domain: message.origin?.domain,
    },
    destination: {
      id: connection.destinationId,
      type: connection.type,
      updatedAt: connection.updatedAt,
      hash: connection.credentialsHash,
    },
    connection: {
      id: connection.id,
      options: connection.options,
    },
    workspace: {
      id: connection.workspaceId,
    },
  };
  if (connection.type === "profiles") {
    ctx.allConnections = streamsStore.getObject(ctx.source.id)?.destinations?.map(d => ({
      id: d.connectionId,
      destinationId: d.id,
      destinationName: d.name,
      type: d.destinationType,
      mode: d.options?.mode,
    }));
  }

  const metricsMeta: MetricsMeta = {
    workspaceId: connection.workspaceId,
    messageId: message.messageId,
    streamId: connection.streamId,
    destinationId: connection.destinationId,
    connectionId: connection.id,
    retries,
  };

  // Prefer functionsServer info provided by the Console export. Operatorless
  // installations can use one fixed internal server instead.
  let functionsServer = connection.options?.functionsServer as
    | { deploymentId: string; status: "functions" | "empty" | "missing" }
    | undefined;

  const allowMissingFunctionsServer = serverEnv.ROTOR_ALLOW_MISSING_FUNCTIONS_SERVER === "true";
  const hasUdfFunctions = (connection.options?.functions || []).some((f: any) => f.functionId?.startsWith("udf."));
  if (hasUdfFunctions && serverEnv.FUNCTIONS_SERVER_FALLBACK_URL && functionsServer?.status !== "functions") {
    functionsServer = { deploymentId: "operatorless", status: "functions" };
    if (!operatorlessConnectionsWarned.has(connection.id)) {
      operatorlessConnectionsWarned.add(connection.id);
      log
        .atInfo()
        .log(`[${connection.id}] Using fixed operatorless Functions Server for workspace ${connection.workspaceId}.`);
    }
  }
  if (!functionsServer && !allowMissingFunctionsServer) {
    log
      .atError()
      .log(
        `[${connection.id}] No functionsServer info in connection options for workspace ${connection.workspaceId}. Dropping event.`
      );
    return undefined;
  }
  if (!functionsServer && hasUdfFunctions) {
    log
      .atError()
      .log(
        `[${connection.id}] UDF functions are configured but no functionsServer info is available for workspace ${connection.workspaceId}. Dropping event.`
      );
    return undefined;
  }
  if (!functionsServer) {
    if (!operatorlessConnectionsWarned.has(connection.id)) {
      operatorlessConnectionsWarned.add(connection.id);
      log
        .atWarn()
        .log(
          `[${connection.id}] No functionsServer info for workspace ${connection.workspaceId}; continuing without UDF functions because ROTOR_ALLOW_MISSING_FUNCTIONS_SERVER=true.`
        );
    }
  }
  if (functionsServer?.status === "missing") {
    log
      .atError()
      .log(
        `[${connection.id}] Connection is missing in functionsServer ${functionsServer.deploymentId} for workspace ${connection.workspaceId}. Dropping event.`
      );
    // Connection not yet known to the functions server deployment — drop silently
    return undefined;
  }
  // skipUdf: when "empty" — connection has no UDF functions, skip UDF step entirely
  const skipUdf = !functionsServer || functionsServer.status === "empty";
  const effectiveConnection =
    functionsServer === connection.options?.functionsServer
      ? connection
      : {
          ...connection,
          options: { ...connection.options, functionsServer },
        };
  ctx.connection.options = effectiveConnection.options;

  let lastUpdated = Math.max(
    new Date(effectiveConnection.updatedAt || 0).getTime(),
    new Date(effectiveConnection.options?.workspaceUpdatedAt || 0).getTime()
  );
  const cacheKey = `${connection.id}_${lastUpdated}_${functionsServer?.deploymentId}_${functionsServer?.status}`;
  let funcChain: FuncChain | undefined = funcsChainCache.get(cacheKey);
  if (!funcChain) {
    log.atDebug().log(`[${connection.id}] Refreshing function chain. Dt: ${lastUpdated}`);
    funcChain = buildFunctionChain(
      skipUdf,
      effectiveConnection,
      connStore,
      rotorContext,
      anonymousEventsStore,
      fetchTimeoutMs
    );
    funcsChainCache.set(cacheKey, funcChain);
  }

  const chainRes = await runChain(
    funcChain,
    event,
    ctx,
    metricsMeta,
    runFuncs,
    !!connection.options?.noretry ? false : retriesEnabled
  );
  chainRes.connectionId = connectionId;
  rotorContext.metrics?.logMetrics(chainRes.execLog);
  checkError(chainRes);
  return chainRes;
}
