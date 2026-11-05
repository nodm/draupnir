#!/usr/bin/env bash
# Starts Draupnir over: empties the database tables, the uploads bucket and the
# bot's queues, including the Telegram link (send /start again afterwards).
# Destructive and not reversible, so it only looks unless told otherwise.
#
#   pnpm exec nx run infra:reset-data                                  dry run: shows what exists
#   pnpm exec nx run infra:reset-data -- --i-know-this-deletes-everything
#   ... add --snapshot to take a database snapshot first (kept until you delete it)
#
# Kept on purpose: the schema and `schema_migrations`, and `bot_messages`, so the
# hourly retention run can still delete the bot's old messages from the chat
# (messages older than 48 hours cannot be deleted by anyone).
#
# Needs the AWS CLI logged in and `pulumi login` done (see infra/README.md).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Every table in the public schema is either emptied or kept, and a test
# (shared/src/lib/resetScript.spec.ts) fails when a table is in neither list, so a
# new table cannot be forgotten here. Keep each list on one line.
RESET_TABLES="accounts account_members statement_files statement_file_accounts raw_rows transactions transaction_sources statement_outcome_outbox bot_pending_uploads bot_conversations messenger_links link_requests"
KEPT_TABLES="bot_messages"

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

echo "stack:   $(cd infra && pulumi stack --show-name)"
echo "account: $(aws sts get-caller-identity --query Account --output text)"
echo "cluster: $CLUSTER_ID"
echo "bucket:  $BUCKET"

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

echo
echo "== What exists now"
echo "database:"
sql "$(counts_sql)"
echo "bucket:"
aws s3 ls "s3://$BUCKET" --recursive --summarize | tail -2 || true

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
echo "== Emptying the database (point of no return)"
# No CASCADE: every table that references another is listed, so one missed here
# makes the statement fail instead of being deleted silently.
sql "TRUNCATE ${RESET_TABLES// /, }" >/dev/null

echo "== Emptying the uploads bucket"
aws s3 rm "s3://$BUCKET" --recursive --only-show-errors

echo "== Purging the bot's queues (messages in flight are dropped)"
aws sqs purge-queue --queue-url "$UPDATES_Q"
aws sqs purge-queue --queue-url "$OUTCOMES_Q"

echo
echo "== Now"
echo "database:"
sql "$(counts_sql)"
echo "bucket objects: $(aws s3 ls "s3://$BUCKET" --recursive | wc -l | tr -d ' ')"

cat <<'DONE'

Done. To start using the bot:
  1. Send /start, sign in with Google, send back the 6-digit code.
  2. /newaccount, then send a statement CSV.
Old bot messages stay in the chat until the hourly run deletes them (within about
25 hours; older than 48 hours they cannot be deleted).
DONE
