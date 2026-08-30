import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
});

const LAMBDA_BASIC_EXECUTION_POLICY_ARN =
  'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

// A file failing every retry is retained for inspection rather than
// discarded, per the statement-ingestion-pipeline spec.
const MAX_RECEIVE_COUNT = 5;

export interface DbConfig {
  clusterArn: pulumi.Input<string>;
  secretArn: pulumi.Input<string>;
  name: pulumi.Input<string>;
}

// Read once here; `pulumi.Config` provisioning for these keys (an Aurora
// Serverless v2 cluster, its Secrets Manager secret) is out of scope for
// this change — see ADR-0003's own unchecked action items. `pulumi preview`/
// `up` will fail until a later change provisions Aurora and this stack's
// config sets `draupnir-infra:dbClusterArn`/`dbSecretArn`/`dbName`.
export function loadDbConfig(): DbConfig {
  const config = new pulumi.Config();
  return {
    clusterArn: config.require('dbClusterArn'),
    secretArn: config.requireSecret('dbSecretArn'),
    name: config.require('dbName'),
  };
}

export function dataApiPolicyStatements(
  dbConfig: DbConfig,
): pulumi.Input<Record<string, unknown>>[] {
  return [
    {
      Effect: 'Allow',
      Action: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      Resource: dbConfig.clusterArn,
    },
    {
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Resource: dbConfig.secretArn,
    },
  ];
}

export interface IngestionPipeline {
  uploadsBucket: aws.s3.Bucket;
  queue: aws.sqs.Queue;
  deadLetterQueue: aws.sqs.Queue;
  ingestFunction: aws.lambda.Function;
}

export function createIngestionPipeline(
  provider: aws.Provider,
  dbConfig: DbConfig,
): IngestionPipeline {
  const withProvider = { provider };

  const uploadsBucket = new aws.s3.Bucket('uploads', {}, withProvider);

  const deadLetterQueue = new aws.sqs.Queue(
    'ingestion-dlq',
    {},
    withProvider,
  );

  const queue = new aws.sqs.Queue(
    'ingestion',
    {
      redrivePolicy: pulumi.jsonStringify({
        deadLetterTargetArn: deadLetterQueue.arn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    },
    withProvider,
  );

  const queuePolicy = new aws.sqs.QueuePolicy(
    'ingestion',
    {
      queueUrl: queue.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 's3.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: queue.arn,
            Condition: { ArnEquals: { 'aws:SourceArn': uploadsBucket.arn } },
          },
        ],
      }),
    },
    withProvider,
  );

  new aws.s3.BucketNotification(
    'uploads',
    {
      bucket: uploadsBucket.id,
      queues: [{ queueArn: queue.arn, events: ['s3:ObjectCreated:*'] }],
    },
    { provider, dependsOn: [queuePolicy] },
  );

  const role = new aws.iam.Role(
    'ingest',
    { assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    withProvider,
  );

  new aws.iam.RolePolicyAttachment(
    'ingest-logs',
    { role: role.name, policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN },
    withProvider,
  );

  new aws.iam.RolePolicy(
    'ingest-policy',
    {
      role: role.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          ...dataApiPolicyStatements(dbConfig),
          {
            Effect: 'Allow',
            Action: 's3:GetObject',
            Resource: pulumi.interpolate`${uploadsBucket.arn}/*`,
          },
          {
            Effect: 'Allow',
            Action: [
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueAttributes',
            ],
            Resource: queue.arn,
          },
        ],
      }),
    },
    withProvider,
  );

  const ingestFunction = new aws.lambda.Function(
    'ingest',
    {
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      handler: 'handler.handler',
      code: new pulumi.asset.FileArchive('../dist/ingestion'),
      environment: {
        variables: {
          DB_CLUSTER_ARN: dbConfig.clusterArn,
          DB_SECRET_ARN: dbConfig.secretArn,
          DB_NAME: dbConfig.name,
        },
      },
    },
    withProvider,
  );

  new aws.lambda.EventSourceMapping(
    'ingest',
    {
      eventSourceArn: queue.arn,
      functionName: ingestFunction.name,
      batchSize: 1,
    },
    withProvider,
  );

  return { uploadsBucket, queue, deadLetterQueue, ingestFunction };
}
