import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';
import {
  LAMBDA_ASSUME_ROLE_POLICY,
  LAMBDA_BASIC_EXECUTION_POLICY_ARN,
} from './lambdaRoute';

const MIGRATION_BUNDLE_DIR = '../dist/infra/migrateDatabase';
// Covers a paused-cluster resume (~2 min retry cap) plus waiting on the
// migration lock with room left to roll back (design.md decisions 2 and 4).
const MIGRATE_FUNCTION_TIMEOUT_SECONDS = 300;

export interface DatabaseMigrations {
  migrateFunction: aws.lambda.Function;
  // Application Lambdas that need the schema list this in `dependsOn` so they
  // update only after migrations succeed.
  invocation: aws.lambda.Invocation;
}

// The Pulumi program can't import `shared` at runtime (ts-node has no tsconfig
// paths), so the trigger hashes the esbuild bundle, which inlines MIGRATIONS.
// It therefore also changes on runner changes; re-running is harmless because
// the runner is idempotent.
function bundleChecksum(): string {
  return createHash('sha256')
    .update(readFileSync(`${MIGRATION_BUNDLE_DIR}/migrateDatabase.cjs`))
    .digest('hex');
}

export function createDatabaseMigrations(
  provider: aws.Provider,
  dbConfig: DbConfig,
  database: pulumi.Resource,
): DatabaseMigrations {
  const withProvider = { provider };

  const role = new aws.iam.Role(
    'migrate-database',
    { assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    withProvider,
  );

  new aws.iam.RolePolicyAttachment(
    'migrate-database-logs',
    { role: role.name, policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN },
    withProvider,
  );

  const rolePolicy = new aws.iam.RolePolicy(
    'migrate-database-policy',
    {
      role: role.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: dataApiPolicyStatements(dbConfig),
      }),
    },
    withProvider,
  );

  // No VPC: reaches Aurora only through RDS Data API (ADR-0003).
  const migrateFunction = new aws.lambda.Function(
    'migrate-database',
    {
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS24dX,
      handler: 'migrateDatabase.handler',
      timeout: MIGRATE_FUNCTION_TIMEOUT_SECONDS,
      code: new pulumi.asset.FileArchive(MIGRATION_BUNDLE_DIR),
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

  // A function error fails the Invocation, which fails `pulumi up`.
  const invocation = new aws.lambda.Invocation(
    'migrate-database',
    {
      functionName: migrateFunction.name,
      input: JSON.stringify({}),
      // Target identity is part of the trigger: pointing at a new cluster or
      // database must re-run migrations even if the bundle is unchanged.
      triggers: {
        bundle: bundleChecksum(),
        clusterArn: dbConfig.clusterArn,
        secretArn: dbConfig.secretArn,
        database: dbConfig.name,
      },
    },
    { ...withProvider, dependsOn: [database, rolePolicy] },
  );

  return { migrateFunction, invocation };
}
