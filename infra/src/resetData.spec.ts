import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs infra/scripts/reset-data.sh against fake `aws` and `pulumi` programs that
// record every call, so what it would do to a real account can be checked
// without touching one. The point: it only looks unless told to delete.

const SCRIPT = resolve(__dirname, '../scripts/reset-data.sh');

const FAKE_AWS = `#!/usr/bin/env bash
echo "aws $*" >> "$CALLS"
sql=""
prev=""
uuid=""
for a in "$@"; do
  [ "$prev" = "--sql" ] && sql="$a"
  [ "$prev" = "--uuid" ] && uuid="$a"
  prev="$a"
done
[ -n "$sql" ] && echo "SQL $sql" >> "$CALLS"
fail() { echo "$1" >&2; exit 1; }
case "$1 $2" in
  "rds describe-db-clusters")
    printf 'cluster-1\\tarn:cluster-1\\tarn:secret-1\\n'
    [ -n "\${SECOND_CLUSTER:-}" ] && printf 'cluster-2\\tarn:cluster-2\\tarn:secret-2\\n'
    ;;
  "rds-data execute-statement")
    if [ -n "\${FAIL_ON:-}" ] && [[ "$sql" == *"$FAIL_ON"* ]]; then fail AccessDenied; fi
    echo '[{"accounts":1}]' ;;
  "sts get-caller-identity")
    [ -n "\${FAIL_STS:-}" ] && fail "ExpiredToken"
    echo 123456789012 ;;
  "s3api head-bucket"|"s3api list-objects-v2")
    [ -n "\${FAIL_S3:-}" ] && fail "AccessDenied: bucket"
    [ "$2" = list-objects-v2 ] && echo 1 ;;
  "lambda list-functions") echo bot-worker-abc ;;
  "lambda list-event-source-mappings") printf 'uuid-1\\tuuid-2\\n' ;;
  "lambda update-event-source-mapping")
    case " $* " in
      *" --no-enabled "*) echo Disabled > "$STATE_DIR/$uuid" ;;
      *) echo Enabled > "$STATE_DIR/$uuid" ;;
    esac ;;
  "lambda get-event-source-mapping")
    if [ -f "$STATE_DIR/$uuid" ] && [ -z "\${STUCK:-}" ]; then cat "$STATE_DIR/$uuid"
    elif [ -n "\${STUCK:-}" ] && [ -f "$STATE_DIR/$uuid" ]; then echo Disabling
    else echo Enabled; fi ;;
  "rds create-db-cluster-snapshot") echo snapshot-name ;;
esac
exit 0
`;

const FAKE_PULUMI = `#!/usr/bin/env bash
echo "pulumi $*" >> "$CALLS"
case "$*" in
  "stack --show-name")
    [ -n "\${FAIL_STACK:-}" ] && { echo "no stack" >&2; exit 1; }
    echo prod ;;
  "stack output uploadsBucketName") echo test-bucket ;;
  "stack output botUpdatesQueueUrl") echo https://sqs/updates.fifo ;;
  "stack output botOutcomesQueueUrl") echo https://sqs/outcomes ;;
esac
`;

function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reset-data-'));
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  mkdirSync(join(dir, 'state'));
  for (const [name, body] of [
    ['aws', FAKE_AWS],
    ['pulumi', FAKE_PULUMI],
  ] as const) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env['PATH']}`,
      CALLS: calls,
      STATE_DIR: join(dir, 'state'),
      RESET_DRAIN_SECONDS: '0',
      RESET_POLL_INTERVAL: '0',
      ...env,
    },
  });
  const log = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { ...result, log };
}

const DESTRUCTIVE =
  /s3 rm|purge-queue|create-db-cluster-snapshot|TRUNCATE|update-event-source-mapping/;
const destructive = (log: string[]) => log.filter((l) => DESTRUCTIVE.test(l));
const FLAG = '--i-know-this-deletes-everything';
const order = (log: string[], re: RegExp) => log.findIndex((l) => re.test(l));
const lastOrder = (log: string[], re: RegExp) =>
  log.map((l) => re.test(l)).lastIndexOf(true);

describe('reset-data.sh dry run', () => {
  it('only looks: nothing is deleted, purged, snapshotted or switched off', () => {
    const r = run([]);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dry run: nothing was changed/);
    expect(destructive(r.log)).toEqual([]);
    // it did look: counts, bucket, and the consumers
    expect(r.log.some((l) => l.startsWith('SQL SELECT'))).toBe(true);
    expect(r.log.some((l) => l.includes('s3api list-objects-v2'))).toBe(true);
    expect(r.log.some((l) => l.includes('get-event-source-mapping'))).toBe(
      true,
    );
  });

  it('does not even snapshot on a dry run that asks for one', () => {
    const r = run(['--snapshot']);
    expect(r.status).toBe(0);
    expect(destructive(r.log)).toEqual([]);
  });

  it('reports which stack, account and cluster it is about to act on', () => {
    const r = run([]);
    expect(r.stdout).toMatch(/stack:\s+prod/);
    expect(r.stdout).toMatch(/account:\s+123456789012/);
    expect(r.stdout).toMatch(/cluster:\s+cluster-1/);
  });
});

describe('reset-data.sh reset', () => {
  it('switches the consumers off first, wipes, purges, and switches them back on', () => {
    const r = run([FLAG]);

    expect(r.status).toBe(0);
    const off = order(r.log, /update-event-source-mapping.*--no-enabled/);
    const truncate = order(r.log, /TRUNCATE/);
    const rm = order(r.log, /s3 rm s3:\/\/test-bucket/);
    const purge = order(r.log, /purge-queue/);
    const on = lastOrder(
      r.log,
      /update-event-source-mapping --uuid \S+ --enabled/,
    );

    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(truncate);
    expect(truncate).toBeLessThan(rm);
    expect(rm).toBeLessThan(purge);
    expect(purge).toBeLessThan(on);
    // both consumers, both ways
    expect(r.log.filter((l) => l.includes('--no-enabled'))).toHaveLength(2);
    expect(
      r.log.filter((l) => /update-event-source-mapping.* --enabled/.test(l)),
    ).toHaveLength(2);
    expect(r.stdout).toMatch(/consumers are on again/);
  });

  it('empties every table without CASCADE, keeping bot_messages and schema_migrations', () => {
    const r = run([FLAG]);

    const truncate = r.log.find((l) => l.includes('TRUNCATE')) as string;
    expect(truncate).toMatch(/TRUNCATE accounts, account_members,/);
    expect(truncate).toContain('messenger_links, link_requests');
    expect(truncate).not.toMatch(/CASCADE|bot_messages|schema_migrations/i);
  });

  it('purges both queues', () => {
    const r = run([FLAG]);
    expect(r.log.filter((l) => l.includes('purge-queue'))).toEqual([
      'aws sqs purge-queue --queue-url https://sqs/updates.fifo',
      'aws sqs purge-queue --queue-url https://sqs/outcomes',
    ]);
    expect(r.log.some((l) => l.includes('create-db-cluster-snapshot'))).toBe(
      false,
    );
  });

  it('with --snapshot, snapshots before it switches anything off or deletes', () => {
    const r = run([FLAG, '--snapshot']);

    expect(r.status).toBe(0);
    const snapshot = order(r.log, /create-db-cluster-snapshot/);
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeLessThan(order(r.log, /--no-enabled/));
    expect(snapshot).toBeLessThan(order(r.log, /TRUNCATE/));
  });

  it('turns the consumers back on when emptying the database fails, and touches nothing else', () => {
    const r = run([FLAG], { FAIL_ON: 'TRUNCATE' });

    expect(r.status).not.toBe(0);
    expect(r.log.some((l) => /s3 rm|purge-queue/.test(l))).toBe(false);
    expect(order(r.log, /--no-enabled/)).toBeGreaterThanOrEqual(0);
    expect(
      lastOrder(r.log, /update-event-source-mapping.* --enabled/),
    ).toBeGreaterThan(order(r.log, /TRUNCATE/));
  });

  it('does not wipe anything if a consumer will not switch off', () => {
    const r = run([FLAG], { STUCK: '1', RESET_POLL_INTERVAL: '0' });

    expect(r.status).not.toBe(0);
    expect(r.log.some((l) => /TRUNCATE|s3 rm|purge-queue/.test(l))).toBe(false);
    // and it leaves the bot running
    expect(
      lastOrder(r.log, /update-event-source-mapping.* --enabled/),
    ).toBeGreaterThan(order(r.log, /--no-enabled/));
  });
});

describe('reset-data.sh refuses to continue on a doubtful start', () => {
  it('stops when the bucket cannot be reached, even for a dry run', () => {
    for (const args of [[], [FLAG]]) {
      const r = run(args, { FAIL_S3: '1' });

      expect(r.status).not.toBe(0);
      expect(destructive(r.log)).toEqual([]);
    }
  });

  it('stops when it cannot tell which AWS account it is in', () => {
    const r = run([FLAG], { FAIL_STS: '1' });

    expect(r.status).not.toBe(0);
    expect(destructive(r.log)).toEqual([]);
  });

  it('stops when it cannot tell which Pulumi stack it is on', () => {
    const r = run([FLAG], { FAIL_STACK: '1' });

    expect(r.status).not.toBe(0);
    expect(destructive(r.log)).toEqual([]);
  });

  it('refuses an unknown argument before calling AWS at all', () => {
    const r = run(['--yes']);

    expect(r.status).toBe(2);
    expect(r.log).toEqual([]);
  });

  it('refuses to guess when more than one cluster is tagged for the project', () => {
    const r = run([FLAG], { SECOND_CLUSTER: '1' });

    expect(r.status).not.toBe(0);
    expect(destructive(r.log)).toEqual([]);
  });
});
