#!/bin/bash

cancel_healthcheck="0"
inited="0"
export CONSOLE_INIT_TOKEN=$RANDOM$RANDOM$RANDOM$RANDOM
export my_pid=$$

base_path="${NEXT_PUBLIC_BASE_PATH:-}"
if [ -n "$base_path" ] && [ "${base_path#/}" = "$base_path" ]; then
  base_path="/$base_path"
fi
base_path="${base_path%/}"
console_base_url="http://localhost:3000${base_path}"

init() {
  if [ "$inited" = "0" ]; then
    echo "Initializing console..."
    if ! curl --fail --silent --show-error \
      "${console_base_url}/api/admin/events-log-init?token=${CONSOLE_INIT_TOKEN}"; then
      echo "Console initialization failed."
      return 1
    fi
    inited="1"
    echo ""
    if [ "$CRON_ENABLED" != "0" ] && [ "$CRON_ENABLED" != "no" ] && [ "$CRON_ENABLED" != "false" ]; then
      echo "Starting cron..."
      cron
    else
      echo "CRON_ENABLED=$CRON_ENABLED, skipping cron."
    fi
  fi
}

wait_for_service() {
    local address=$1
    local interval=$2
    local max_wait=$3
    local host="${address%:*}"
    local port="${address##*:}"

    local start_time
    local end_time
    local current_time
    start_time=$(date +%s)
    end_time=$((start_time + max_wait))

    while true; do
        if nc -z "$host" "$port" >/dev/null 2>&1; then
            return 0
        fi

        current_time=$(date +%s)

        if [ $current_time -ge $end_time ]; then
            return 1
        fi
        sleep $interval
    done
}

healthcheck() {
  local pid=$1
  local healthcheck_url="${console_base_url}/api/healthcheck"
  local healthcheck_result="/tmp/jitsu-console-healthcheck-${pid}"
  local http_code

  echo "Waiting for localhost:3000 to be up..."
  if ! wait_for_service localhost:3000 1 10; then
    echo "❌ ❌ ❌ HEALTHCHECK FAILED - $healthcheck_url is not UP"
    kill -9 "$pid"
    return 1
  fi

  if [ "$cancel_healthcheck" = "0" ]; then
    echo "Running healthcheck..."
    http_code=$(curl --silent --show-error "$healthcheck_url" -o "$healthcheck_result" -w '%{http_code}')
    if [ "$http_code" = "200" ]; then
        echo "⚡️⚡️⚡️ HEALTHCHECK PASSED - $http_code from $healthcheck_url. Details:"
        if [ -f "$healthcheck_result" ]; then
            cat "$healthcheck_result"
        fi
        echo ""
        if ! init; then
          rm -f "$healthcheck_result"
          kill -9 "$pid"
          return 1
        fi
    else
        if [ "$http_code" = "000" ]; then
            echo "❌ ❌ ❌ HEALTHCHECK FAILED $healthcheck_url is not available"
        else
            echo "❌ ❌ ❌ HEALTHCHECK FAILED - $http_code from $healthcheck_url. Response:"
            if [ -f "$healthcheck_result" ]; then
                cat "$healthcheck_result"
            fi
            echo ""
        fi
        rm -f "$healthcheck_result"
        kill -9 "$pid"
        return 1
    fi
    rm -f "$healthcheck_result"
  fi
}

main() {
  cmd=$1
  export SIGNALS_LIFECYCLE=1
  if [ -z "$cmd" ]; then
    if [ "$FORCE_UPDATE_DB" = "1" ] || [ "$FORCE_UPDATE_DB" = "yes" ] || [ "$FORCE_UPDATE_DB" = "true" ]; then
      echo "FORCE_UPDATE_DB is set, updating database schema..."
      prisma db push --skip-generate --schema schema.prisma --accept-data-loss
    elif [ "$UPDATE_DB" != "0" ] && [ "$UPDATE_DB" != "no" ] && [ "$UPDATE_DB" != "false" ]; then
      echo "Updating database schema..."
      prisma db push --skip-generate --schema schema.prisma
    fi

    # Seed the initial user/workspace when credentials are provided, and seed
    # optional demo configuration when SEED_DEMO_CONFIGURATION is set.
    if [ -n "${SEED_DEMO_CONFIGURATION:-}" ] || \
       { [ -n "${SEED_USER_EMAIL:-}" ] && [ -n "${SEED_USER_PASSWORD:-}" ]; }; then
      echo "Seeding initial user, workspace, and optional demo configuration..."
      if ! node /app/webapps/console/build/manage.js seed; then
        echo "Jitsu seed failed; refusing to start Console."
        exit 1
      fi
    fi

    echo "Starting the app"
    healthcheck $$ &
    healthcheck_pid=$!

    cd /app/webapps/console
    HOSTNAME="::" node server.js
    exit_code=$?

    cancel_healthcheck="1"
    kill "$healthcheck_pid" >/dev/null 2>&1 || true
    wait "$healthcheck_pid" >/dev/null 2>&1 || true
    echo "App stopped with exit code ${exit_code}, exiting..."
    exit "$exit_code"

  elif [ "$cmd" = "db-prepare" ]; then
    prisma db push --skip-generate --schema schema.prisma
  else
    echo "ERROR! Unknown command '$cmd'"
    exit 1
  fi
}

main "$@"
