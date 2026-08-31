import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import type { DbConfig } from './ingestionPipeline';

const DB_NAME = 'draupnir';
// RDS's CreateDBCluster only accepts 1-16 letters or numbers here — no
// underscores or other punctuation.
const MASTER_USERNAME = 'draupniradmin';

// 0 lets the cluster pause to $0 compute between uses — Aurora PostgreSQL
// 17.7 supports scale-to-zero — matching ADR-0001/ADR-0003's near-zero-
// idle-cost framing for occasional 2-user load. Not sized for sustained
// throughput.
const MIN_CAPACITY_ACU = 0;
const MAX_CAPACITY_ACU = 1;
// Resume from a pause takes several seconds to ~1 minute, so this trades a
// bit of first-request latency after idle for not paying for compute the
// rest of the time. AWS's own default.
const SECONDS_UNTIL_AUTO_PAUSE = 300;

export interface AuroraCluster {
  dbConfig: DbConfig;
  vpc: aws.ec2.Vpc;
  cluster: aws.rds.Cluster;
}

export function createAuroraCluster(provider: aws.Provider): AuroraCluster {
  const withProvider = { provider };

  const vpc = new aws.ec2.Vpc(
    'aurora',
    { cidrBlock: '10.0.0.0/16' },
    withProvider,
  );

  const availabilityZoneNames = aws
    .getAvailabilityZonesOutput({ state: 'available' }, { provider })
    .apply((azs) => azs.names);

  // Aurora requires a DB subnet group spanning at least two AZs — this is
  // that minimum, not a high-availability decision. No NAT Gateway/internet
  // gateway: nothing in this VPC makes outbound calls, per ADR-0003.
  const subnetA = new aws.ec2.Subnet(
    'aurora-a',
    {
      vpcId: vpc.id,
      cidrBlock: '10.0.0.0/24',
      availabilityZone: availabilityZoneNames.apply((names) => names[0]),
    },
    withProvider,
  );

  const subnetB = new aws.ec2.Subnet(
    'aurora-b',
    {
      vpcId: vpc.id,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: availabilityZoneNames.apply((names) => names[1]),
    },
    withProvider,
  );

  const subnetGroup = new aws.rds.SubnetGroup(
    'aurora',
    { subnetIds: [subnetA.id, subnetB.id] },
    withProvider,
  );

  // No ingress rule: Lambda reaches the cluster only through RDS Data
  // API's regional HTTPS endpoint, never a direct Postgres connection, so
  // no compute resource ever needs network-level access — per ADR-0003 and
  // the aurora-data-access spec.
  const securityGroup = new aws.ec2.SecurityGroup(
    'aurora',
    { vpcId: vpc.id },
    withProvider,
  );

  const cluster = new aws.rds.Cluster(
    'aurora',
    {
      engine: aws.rds.EngineType.AuroraPostgresql,
      engineMode: aws.rds.EngineMode.Provisioned,
      engineVersion: '17.7',
      databaseName: DB_NAME,
      masterUsername: MASTER_USERNAME,
      // AWS creates and owns the Secrets Manager secret — no password
      // material ever exists in Pulumi state or this code.
      manageMasterUserPassword: true,
      dbSubnetGroupName: subnetGroup.name,
      vpcSecurityGroupIds: [securityGroup.id],
      enableHttpEndpoint: true,
      serverlessv2ScalingConfiguration: {
        minCapacity: MIN_CAPACITY_ACU,
        maxCapacity: MAX_CAPACITY_ACU,
        secondsUntilAutoPause: SECONDS_UNTIL_AUTO_PAUSE,
      },
      // This cluster is about to hold live account/transaction data once
      // import-bank-statements deploys, so an accidental `pulumi destroy`
      // or a replacement (e.g. an engine-version bump) must not silently
      // discard it: deletion protection blocks the delete outright, and a
      // final snapshot is still taken on any deletion that does go through.
      // Scoped to the stack name since RDS requires the identifier to be
      // unique in the account/region — a second full teardown-and-recreate
      // of the same stack needs that prior snapshot deleted/renamed first,
      // which is a deliberate manual gate, not a data-loss path.
      deletionProtection: true,
      finalSnapshotIdentifier: `aurora-final-snapshot-${pulumi.getStack()}`,
    },
    withProvider,
  );

  new aws.rds.ClusterInstance(
    'aurora',
    {
      clusterIdentifier: cluster.id,
      instanceClass: 'db.serverless',
      // `cluster.engine` is a plain Output<string>, but at runtime it can
      // only ever be the aurora-postgresql value this cluster was created
      // with — narrow the type to satisfy ClusterInstance's stricter input.
      engine: cluster.engine.apply((engine) => engine as aws.rds.EngineType),
      engineVersion: cluster.engineVersion,
    },
    withProvider,
  );

  return {
    dbConfig: {
      clusterArn: cluster.arn,
      secretArn: cluster.masterUserSecrets.apply((secrets) => {
        const secret = secrets[0];
        if (!secret) {
          throw new Error(
            'Aurora cluster has no master user secret — manageMasterUserPassword must be enabled',
          );
        }
        return secret.secretArn;
      }),
      name: DB_NAME,
    },
    vpc,
    cluster,
  };
}
