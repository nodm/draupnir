#!/usr/bin/env bash
# Starts Draupnir over: empties the database tables, the uploads bucket and the
# bot's queues, including the Telegram link (send /start again afterwards).
# Destructive and not reversible, so it only looks unless told otherwise.
#
#   pnpm exec nx run infra:reset-data                                  dry run: shows what exists
#   pnpm exec nx run infra:reset-data -- --i-know-this-deletes-everything
#   ... add --snapshot to take a database snapshot first (kept until you delete it)
#
# A real reset first stops the bot's queue consumers and waits for work already in
# flight, so nothing recreates data while it is wiped; it turns them back on at
# the end, and also if it fails part way.
#
# Kept on purpose: the schema, `schema_migrations`, and `bot_messages`, so the
# hourly retention run can still delete the bot's old messages from the chat
# (messages older than 48 hours cannot be deleted by anyone).
#
# Needs the AWS CLI logged in and `pulumi login` done (see infra/README.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Every table in the database is either emptied or kept, and a test
# (shared/src/lib/resetScript.spec.ts, run against a database built by the real
# migration runner) fails when a table is in neither list, so a new table cannot
# be forgotten here. Keep each list on one line.
RESET_TABLES="accounts account_members statement_files statement_file_accounts raw_rows transactions transaction_sources statement_outcome_outbox bot_pending_uploads bot_conversations messenger_links link_requests"
KEPT_TABLES="bot_messages schema_migrations"

# The worker Lambda's timeout is 90 s (infra/lib/botQueues.ts); work already
# running when its queues are switched off can still finish within that.
DRAIN_SECONDS=${RESET_DRAIN_SECONDS:-100}
POLL_SECONDS=${RESET_POLL_INTERVAL:-3}

DO_IT=no
SNAPSHOT=no
for arg in "$@"; do
  case "$arg" in
    --i-know-this-deletes-everything) DO_IT=yes ;;
    --snapshot) SNAPSHOT=yes ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

output() { (cd infra && pulumi stack output "$1"); }

# Every lookup below is an assignment, so a failure stops the script (set -e
# does not see a failure hidden inside echo or a pipeline's first stage).
STACK=$(cd infra && pulumi stack --show-name)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# The Draupnir cluster is the one the stack tagged Project=draupnir.
CLUSTERS=$(aws rds describe-db-clusters \
  --query "DBClusters[?TagList[?Key=='Project' && Value=='draupnir']].[DBClusterIdentifier,DBClusterArn,MasterUserSecret.SecretArn]" \
  --output text)
if [ "$(printf '%s\n' "$CLUSTERS" | grep -c .)" -ne 1 ]; then
  echo "expected exactly one cluster tagged Project=draupnir, found:" >&2
  echo "${CLUSTERS:-none}" >&2
  exit 1
fi
read -r CLUSTER_ID CLUSTER_ARN SECRET_ARN <<<"$CLUSTERS"

BUCKET=$(output uploadsBucketName)
UPDATES_Q=$(output botUpdatesQueueUrl)
OUTCOMES_Q=$(output botOutcomesQueueUrl)

# The queues feed the worker; find both consumers (event source mappings).
WORKER=$(aws lambda list-functions \
  --query "Functions[?starts_with(FunctionName,'bot-worker')].FunctionName | [0]" --output text)
MAPPINGS=$(aws lambda list-event-source-mappings --function-name "$WORKER" \
  --query 'EventSourceMappings[].UUID' --output text)
if [ "$(printf '%s\n' $MAPPINGS | grep -c .)" -ne 2 ]; then
  echo "expected the worker to have exactly two queue consumers, found: ${MAPPINGS:-none}" >&2
  exit 1
fi

echo "stack:    $STACK"
echo "account:  $ACCOUNT"
echo "cluster:  $CLUSTER_ID"
echo "bucket:   $BUCKET"
echo "worker:   $WORKER"

# Runs one SQL statement as the master user, which bypasses row-level security
# and may truncate. The first call after a pause is refused while Aurora wakes
# (up to about a minute); that refusal comes before anything runs, so asking
# again is safe.
sql() {
  local out
  for attempt in $(seq 1 12); do
    if out=$(aws rds-data execute-statement \
      --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database draupnir \
      --format-records-as JSON --sql "$1" \
      --query formattedRecords --output text 2>&1); then
      echo "$out"
      return 0
    fi
    case "$out" in
      *DatabaseResumingException*) echo "  waking the database (try $attempt)..." >&2; sleep 10 ;;
      *) echo "$out" >&2; return 1 ;;
    esac
  done
  echo "the database did not wake up in two minutes" >&2
  return 1
}

counts_sql() {
  local parts=() table
  for table in $RESET_TABLES; do
    parts+=("(SELECT count(*) FROM $table) AS $table")
  done
  for table in $KEPT_TABLES; do
    parts+=("(SELECT count(*) FROM $table) AS ${table}_kept")
  done
  local IFS=,
  echo "SELECT ${parts[*]}"
}

# Fails if the bucket cannot be reached, instead of reporting nothing. (An empty
# bucket is a normal answer, not an error, so this uses the API that says so.)
bucket_objects() {
  aws s3api head-bucket --bucket "$BUCKET"
  aws s3api list-objects-v2 --bucket "$BUCKET" \
    --query 'length(Contents || `[]`)' --output text | awk '{ n += $1 } END { print n + 0 }'
}

consumer_states() {
  local uuid state
  for uuid in $MAPPINGS; do
    state=$(aws lambda get-event-source-mapping --uuid "$uuid" --query State --output text)
    echo "  $uuid: $state"
  done
}

CONSUMERS_STOPPED=no
start_consumers() {
  [ "$CONSUMERS_STOPPED" = yes ] || return 0
  local uuid failed=no
  for uuid in $MAPPINGS; do
    aws lambda update-event-source-mapping --uuid "$uuid" --enabled >/dev/null || failed=yes
  done
  if [ "$failed" = yes ]; then
    echo "COULD NOT turn the bot's queue consumers back on. Do it by hand:" >&2
    echo "  aws lambda update-event-source-mapping --uuid <uuid> --enabled   ($MAPPINGS)" >&2
    return 1
  fi
  CONSUMERS_STOPPED=no
  echo "== The bot's queue consumers are on again"
}
trap start_consumers EXIT

stop_consumers() {
  local uuid state waited
  CONSUMERS_STOPPED=yes # set first, so a failure half way still turns them back on
  for uuid in $MAPPINGS; do
    aws lambda update-event-source-mapping --uuid "$uuid" --no-enabled >/dev/null
  done
  for uuid in $MAPPINGS; do
    waited=0
    while :; do
      state=$(aws lambda get-event-source-mapping --uuid "$uuid" --query State --output text)
      [ "$state" = Disabled ] && break
      waited=$((waited + 1))
      if [ "$waited" -gt 60 ]; then
        echo "consumer $uuid is still '$state'; giving up before changing any data" >&2
        return 1
      fi
      sleep "$POLL_SECONDS"
    done
  done
  echo "  consumers are off; waiting ${DRAIN_SECONDS}s for work already running to finish"
  sleep "$DRAIN_SECONDS"
}

echo
echo "== What exists now"
echo "database:"
sql "$(counts_sql)"
OBJECTS=$(bucket_objects)
echo "bucket objects: $OBJECTS"
echo "queue consumers:"
consumer_states

if [ "$DO_IT" != yes ]; then
  echo
  echo "Dry run: nothing was changed."
  echo "To delete all of the above: add -- --i-know-this-deletes-everything"
  exit 0
fi

if [ "$SNAPSHOT" = yes ]; then
  echo
  echo "== Snapshot (kept until you delete it: aws rds delete-db-cluster-snapshot)"
  aws rds create-db-cluster-snapshot \
    --db-cluster-identifier "$CLUSTER_ID" \
    --db-cluster-snapshot-identifier "before-reset-$(date -u +%Y%m%d-%H%M%S)" \
    --query 'DBClusterSnapshot.DBClusterSnapshotIdentifier' --output text
fi

echo
echo "== Stopping the bot's queue consumers"
stop_consumers

echo "== Emptying the database (point of no return)"
# No CASCADE: every table that references another is listed, so one missed here
# makes the statement fail instead of being deleted silently.
sql "TRUNCATE ${RESET_TABLES// /, }" >/dev/null

echo "== Emptying the uploads bucket"
aws s3 rm "s3://$BUCKET" --recursive --only-show-errors

# Purged only now: the consumers are off, so whatever arrived while the data was
# being wiped (the webhook keeps accepting messages) is dropped, not replayed.
echo "== Purging the bot's queues"
aws sqs purge-queue --queue-url "$UPDATES_Q"
aws sqs purge-queue --queue-url "$OUTCOMES_Q"

echo
echo "== Now"
echo "database:"
sql "$(counts_sql)"
OBJECTS=$(bucket_objects)
echo "bucket objects: $OBJECTS"

start_consumers

cat <<'DONE'

Done. To start using the bot:
  1. Send /start, sign in with Google, send back the 6-digit code.
  2. /newaccount, then send a statement CSV.
Old bot messages stay in the chat until the hourly run deletes them (within about
25 hours; older than 48 hours they cannot be deleted).
DONE
