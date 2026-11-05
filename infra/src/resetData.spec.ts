import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
for a in "$@"; do
  [ "$prev" = "--sql" ] && sql="$a"
  prev="$a"
done
[ -n "$sql" ] && echo "SQL $sql" >> "$CALLS"
case "$1 $2" in
  "rds describe-db-clusters")
    printf 'cluster-1\\tarn:cluster-1\\tarn:secret-1\\n'
    [ -n "\${SECOND_CLUSTER:-}" ] && printf 'cluster-2\\tarn:cluster-2\\tarn:secret-2\\n'
    ;;
  "rds-data execute-statement")
    if [ -n "\${FAIL_ON:-}" ] && [[ "$sql" == *"$FAIL_ON"* ]]; then
      echo "AccessDenied" >&2; exit 1
    fi
    echo '[{"accounts":1}]' ;;
  "sts get-caller-identity") echo 123456789012 ;;
  "s3 ls") printf 'Total Objects: 1\\n   Total Size: 10\\n' ;;
  "rds create-db-cluster-snapshot") echo snapshot-name ;;
esac
exit 0
`;

const FAKE_PULUMI = `#!/usr/bin/env bash
echo "pulumi $*" >> "$CALLS"
case "$*" in
  "stack --show-name") echo prod ;;
  "stack output uploadsBucketName") echo test-bucket ;;
  "stack output botUpdatesQueueUrl") echo https://sqs/updates.fifo ;;
  "stack output botOutcomesQueueUrl") echo https://sqs/outcomes ;;
esac
`;

function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reset-data-'));
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
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
      ...env,
    },
  });
  const log = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { ...result, log };
}

const DESTRUCTIVE = /s3 rm|purge-queue|create-db-cluster-snapshot|TRUNCATE/;
const destructive = (log: string[]) => log.filter((l) => DESTRUCTIVE.test(l));
const FLAG = '--i-know-this-deletes-everything';

describe('reset-data.sh', () => {
  it('only looks when run without the flag: nothing is deleted, purged or snapshotted', () => {
    const r = run([]);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Dry run: nothing was changed/);
    expect(destructive(r.log)).toEqual([]);
    // it did look: counts and bucket
    expect(r.log.some((l) => l.startsWith('SQL SELECT'))).toBe(true);
    expect(r.log.some((l) => l.startsWith('aws s3 ls'))).toBe(true);
  });

  it('does not even snapshot on a dry run that asks for one', () => {
    const r = run(['--snapshot']);
    expect(r.status).toBe(0);
    expect(destructive(r.log)).toEqual([]);
  });

  it('with the flag: empties every table without CASCADE, then the bucket, then both queues', () => {
    const r = run([FLAG]);

    expect(r.status).toBe(0);
    const truncate = r.log.find((l) => l.includes('TRUNCATE')) as string;
    expect(truncate).toBeDefined();
    expect(truncate).toMatch(/TRUNCATE accounts, account_members,/);
    expect(truncate).toContain('messenger_links, link_requests');
    expect(truncate).not.toMatch(/CASCADE|bot_messages/i);

    const order = (re: RegExp) => r.log.findIndex((l) => re.test(l));
    expect(order(/TRUNCATE/)).toBeLessThan(order(/s3 rm s3:\/\/test-bucket/));
    expect(order(/s3 rm/)).toBeLessThan(order(/purge-queue/));
    expect(r.log.filter((l) => l.includes('purge-queue'))).toEqual([
      'aws sqs purge-queue --queue-url https://sqs/updates.fifo',
      'aws sqs purge-queue --queue-url https://sqs/outcomes',
    ]);
    expect(r.log.some((l) => l.includes('create-db-cluster-snapshot'))).toBe(
      false,
    );
  });

  it('with the flag and --snapshot: snapshots before it deletes anything', () => {
    const r = run([FLAG, '--snapshot']);

    expect(r.status).toBe(0);
    const order = (re: RegExp) => r.log.findIndex((l) => re.test(l));
    expect(order(/create-db-cluster-snapshot/)).toBeGreaterThanOrEqual(0);
    expect(order(/create-db-cluster-snapshot/)).toBeLessThan(order(/TRUNCATE/));
  });

  it('stops before touching the bucket or queues when emptying the database fails', () => {
    const r = run([FLAG], { FAIL_ON: 'TRUNCATE' });

    expect(r.status).not.toBe(0);
    expect(r.log.some((l) => /s3 rm|purge-queue/.test(l))).toBe(false);
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

  it('reports which stack, account and cluster it is about to act on', () => {
    const r = run([]);
    expect(r.stdout).toMatch(/stack:\s+prod/);
    expect(r.stdout).toMatch(/account: 123456789012/);
    expect(r.stdout).toMatch(/cluster: cluster-1/);
  });
});
