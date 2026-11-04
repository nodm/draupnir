import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as random from '@pulumi/random';
import type { AuthPool } from './cognito';
import { BOT_WORKER_TIMEOUT_SECONDS, type BotQueues } from './botQueues';
import { dataApiPolicyStatements, type DbConfig } from './ingestionPipeline';
import {
  LAMBDA_ASSUME_ROLE_POLICY,
  LAMBDA_BASIC_EXECUTION_POLICY_ARN,
} from './lambdaRoute';

const CODE_PATH = '../dist/bot';
// The webhook only validates and enqueues.
const WEBHOOK_TIMEOUT_SECONDS = 10;
// API Gateway's ceiling; the callback talks to Cognito and Aurora (which may
// have to resume from a pause, aurora.ts).
const CALLBACK_TIMEOUT_SECONDS = 29;
// One try per message: up to 2000 deletions per run plus an Aurora resume.
const RETENTION_TIMEOUT_SECONDS = 600;
const RETENTION_SCHEDULE = 'rate(30 minutes)';

// The public endpoints are open to the internet by design (Telegram and the
// user's browser call them), so cap what a flood can cost.
const THROTTLE = { burstLimit: 20, rateLimit: 10 };

export interface BotInputs {
  authPool: AuthPool;
  dbConfig: DbConfig;
  uploadsBucket: aws.s3.Bucket;
  queues: BotQueues;
  // Database migrations: schema before code.
  dependsOn: pulumi.Resource[];
}

export interface Bot {
  restApi: aws.apigateway.RestApi;
  webhookUrl: pulumi.Output<string>;
  callbackUrl: pulumi.Output<string>;
  botTokenSecret: aws.secretsmanager.Secret;
  webhookSecret: aws.secretsmanager.Secret;
  telegramClientId: pulumi.Output<string>;
}

function lambdaRole(
  name: string,
  statements: pulumi.Input<Record<string, unknown>>[],
  provider: aws.Provider,
): { role: aws.iam.Role; policy: aws.iam.RolePolicy } {
  const role = new aws.iam.Role(
    name,
    { assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY },
    { provider },
  );
  new aws.iam.RolePolicyAttachment(
    `${name}-logs`,
    { role: role.name, policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN },
    { provider },
  );
  const policy = new aws.iam.RolePolicy(
    `${name}-policy`,
    {
      role: role.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: statements,
      }),
    },
    { provider },
  );
  return { role, policy };
}

export function createBot(provider: aws.Provider, inputs: BotInputs): Bot {
  const { authPool, dbConfig, uploadsBucket, queues, dependsOn } = inputs;
  const config = new pulumi.Config();
  const region = new pulumi.Config('aws').require('region');
  const stage = pulumi.getStack();
  const withProvider = { provider };

  // The bot's @username (from BotFather), used for the t.me deep links.
  const botUsername = config.require('botUsername');

  // --- API Gateway first: its id fixes the callback URL, which the Cognito
  // client needs before the callback Lambda (which needs the client) exists.
  const restApi = new aws.apigateway.RestApi(
    'bot',
    {
      name: 'draupnir-bot',
      endpointConfiguration: { types: 'REGIONAL' },
    },
    withProvider,
  );
  const callbackUrl = pulumi.interpolate`https://${restApi.id}.execute-api.${region}.amazonaws.com/${stage}/telegram/callback`;

  // --- Secrets --------------------------------------------------------------
  // The token comes from BotFather and is stored by hand (docs/telegram-bot.md);
  // Pulumi owns the secret, never the value.
  const botTokenSecret = new aws.secretsmanager.Secret(
    'bot-token',
    { description: 'Telegram bot token from BotFather' },
    withProvider,
  );

  const webhookSecretValue = new random.RandomPassword('bot-webhook-secret', {
    length: 48,
    // Telegram allows A-Z a-z 0-9 _ - in the secret token.
    special: false,
  });
  const webhookSecret = new aws.secretsmanager.Secret(
    'bot-webhook-secret',
    { description: 'Secret header Telegram sends with every webhook call' },
    withProvider,
  );
  new aws.secretsmanager.SecretVersion(
    'bot-webhook-secret',
    {
      secretId: webhookSecret.id,
      secretString: webhookSecretValue.result,
    },
    withProvider,
  );

  // --- Cognito app client for linking ----------------------------------------
  // Its own client (with a secret, so the code exchange happens server side):
  // the linking flow never shares credentials or callbacks with the web app.
  const telegramClient = new aws.cognito.UserPoolClient(
    'telegram',
    {
      userPoolId: authPool.userPool.id,
      name: 'draupnir-telegram',
      generateSecret: true,
      supportedIdentityProviders: ['Google'],
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ['code'],
      allowedOauthScopes: ['openid', 'email', 'profile'],
      callbackUrls: [callbackUrl],
    },
    { provider, dependsOn: [authPool.googleIdentityProvider] },
  );
  new aws.cognito.ManagedLoginBranding(
    'telegram',
    {
      userPoolId: authPool.userPool.id,
      clientId: telegramClient.id,
      useCognitoProvidedValues: true,
    },
    { provider, dependsOn: [authPool.domain] },
  );

  const clientSecret = new aws.secretsmanager.Secret(
    'bot-telegram-client-secret',
    {
      description: 'Cognito client secret of the draupnir-telegram app client',
    },
    withProvider,
  );
  new aws.secretsmanager.SecretVersion(
    'bot-telegram-client-secret',
    { secretId: clientSecret.id, secretString: telegramClient.clientSecret },
    withProvider,
  );

  const cognitoBaseUrl = pulumi.interpolate`https://${authPool.domain.domain}.auth.${region}.amazoncognito.com`;

  // --- Lambdas ----------------------------------------------------------------
  const dbEnvironment = {
    DB_CLUSTER_ARN: dbConfig.clusterArn,
    DB_SECRET_ARN: dbConfig.secretArn,
    DB_NAME: dbConfig.name,
  };
  const readSecrets = (...secrets: aws.secretsmanager.Secret[]) => ({
    Effect: 'Allow',
    Action: 'secretsmanager:GetSecretValue',
    Resource: secrets.map((s) => s.arn),
  });
  const lambdaFunction = (
    name: string,
    handler: string,
    role: aws.iam.Role,
    policy: aws.iam.RolePolicy,
    options: {
      timeout: number;
      memorySize?: number;
      environment: Record<string, pulumi.Input<string>>;
      afterMigrations?: boolean;
    },
  ) =>
    new aws.lambda.Function(
      name,
      {
        role: role.arn,
        runtime: aws.lambda.Runtime.NodeJS24dX,
        handler,
        timeout: options.timeout,
        memorySize: options.memorySize,
        code: new pulumi.asset.FileArchive(CODE_PATH),
        environment: { variables: options.environment },
      },
      {
        provider,
        dependsOn: [policy, ...(options.afterMigrations ? dependsOn : [])],
      },
    );

  // Public: Telegram calls it. Checks the secret header, enqueues, never
  // touches the database.
  const webhook = lambdaRole(
    'bot-webhook',
    [
      readSecrets(webhookSecret),
      {
        Effect: 'Allow',
        Action: 'sqs:SendMessage',
        Resource: queues.updates.arn,
      },
    ],
    provider,
  );
  const webhookFunction = lambdaFunction(
    'bot-webhook',
    'webhook.handler',
    webhook.role,
    webhook.policy,
    {
      timeout: WEBHOOK_TIMEOUT_SECONDS,
      environment: {
        WEBHOOK_SECRET_ARN: webhookSecret.arn,
        BOT_UPDATES_QUEUE_URL: queues.updates.url,
      },
    },
  );

  // Public: the browser lands here after Google sign-in.
  const callback = lambdaRole(
    'bot-callback',
    [
      ...dataApiPolicyStatements(dbConfig),
      readSecrets(botTokenSecret, clientSecret),
    ],
    provider,
  );
  const callbackFunction = lambdaFunction(
    'bot-callback',
    'callback.handler',
    callback.role,
    callback.policy,
    {
      timeout: CALLBACK_TIMEOUT_SECONDS,
      afterMigrations: true,
      environment: {
        ...dbEnvironment,
        BOT_TOKEN_SECRET_ARN: botTokenSecret.arn,
        TELEGRAM_CLIENT_SECRET_ARN: clientSecret.arn,
        COGNITO_BASE_URL: cognitoBaseUrl,
        TELEGRAM_CLIENT_ID: telegramClient.id,
        TELEGRAM_CALLBACK_URL: callbackUrl,
        BOT_USERNAME: botUsername,
        USER_POOL_ID: authPool.userPool.id,
      },
    },
  );

  // Handles Telegram updates and statement outcomes.
  const worker = lambdaRole(
    'bot-worker',
    [
      ...dataApiPolicyStatements(dbConfig),
      readSecrets(botTokenSecret),
      {
        Effect: 'Allow',
        Action: 's3:PutObject',
        Resource: pulumi.interpolate`${uploadsBucket.arn}/uploads/*`,
      },
      {
        // /share looks users up by email.
        Effect: 'Allow',
        Action: 'cognito-idp:ListUsers',
        Resource: authPool.userPool.arn,
      },
      {
        Effect: 'Allow',
        Action: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
        ],
        Resource: [queues.updates.arn, queues.outcomes.arn],
      },
    ],
    provider,
  );
  const workerFunction = lambdaFunction(
    'bot-worker',
    'worker.handler',
    worker.role,
    worker.policy,
    {
      timeout: BOT_WORKER_TIMEOUT_SECONDS,
      memorySize: 256,
      afterMigrations: true,
      environment: {
        ...dbEnvironment,
        BOT_TOKEN_SECRET_ARN: botTokenSecret.arn,
        UPLOADS_BUCKET: uploadsBucket.bucket,
        COGNITO_BASE_URL: cognitoBaseUrl,
        TELEGRAM_CLIENT_ID: telegramClient.id,
        TELEGRAM_CALLBACK_URL: callbackUrl,
        BOT_USERNAME: botUsername,
        USER_POOL_ID: authPool.userPool.id,
      },
    },
  );

  // Both queues feed the worker. One message at a time keeps FIFO order simple
  // and each message within its own timeout; `ReportBatchItemFailures` is how
  // the worker reports the ones it could not finish.
  for (const [name, queue] of [
    ['bot-updates', queues.updates],
    ['bot-outcomes', queues.outcomes],
  ] as const) {
    new aws.lambda.EventSourceMapping(
      name,
      {
        eventSourceArn: queue.arn,
        functionName: workerFunction.name,
        batchSize: 1,
        functionResponseTypes: ['ReportBatchItemFailures'],
      },
      // The mapping is rejected until the role may already consume the queue.
      { provider, dependsOn: [worker.policy] },
    );
  }

  // Runs on a schedule: deletes old messages, republishes missed outcomes.
  const retention = lambdaRole(
    'bot-retention',
    [
      ...dataApiPolicyStatements(dbConfig),
      readSecrets(botTokenSecret),
      {
        Effect: 'Allow',
        Action: 'sqs:SendMessage',
        Resource: queues.outcomes.arn,
      },
    ],
    provider,
  );
  const retentionFunction = lambdaFunction(
    'bot-retention',
    'retention.handler',
    retention.role,
    retention.policy,
    {
      timeout: RETENTION_TIMEOUT_SECONDS,
      afterMigrations: true,
      environment: {
        ...dbEnvironment,
        BOT_TOKEN_SECRET_ARN: botTokenSecret.arn,
        OUTCOME_QUEUE_URL: queues.outcomes.url,
      },
    },
  );

  const schedulerRole = new aws.iam.Role(
    'bot-retention-schedule',
    {
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      }),
    },
    withProvider,
  );
  const schedulerPolicy = new aws.iam.RolePolicy(
    'bot-retention-schedule',
    {
      role: schedulerRole.id,
      policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'lambda:InvokeFunction',
            Resource: retentionFunction.arn,
          },
        ],
      }),
    },
    withProvider,
  );
  new aws.scheduler.Schedule(
    'bot-retention',
    {
      scheduleExpression: RETENTION_SCHEDULE,
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: retentionFunction.arn,
        roleArn: schedulerRole.arn,
        // A failed run is not retried: each message gets one try (design 8).
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    },
    { provider, dependsOn: [schedulerPolicy] },
  );

  // --- Routes (no authorizer: Telegram and the browser carry no Cognito token)
  const route = (
    name: string,
    parentId: pulumi.Input<string>,
    pathPart: string,
    httpMethod: string,
    fn: aws.lambda.Function,
    timeoutSeconds: number,
  ) => {
    const resource = new aws.apigateway.Resource(
      name,
      { restApi: restApi.id, parentId, pathPart },
      withProvider,
    );
    const method = new aws.apigateway.Method(
      name,
      {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod,
        authorization: 'NONE',
      },
      withProvider,
    );
    const integration = new aws.apigateway.Integration(
      name,
      {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod: method.httpMethod,
        integrationHttpMethod: 'POST',
        type: 'AWS_PROXY',
        uri: fn.invokeArn,
        timeoutMilliseconds: timeoutSeconds * 1000,
      },
      withProvider,
    );
    new aws.lambda.Permission(
      `${name}-invoke`,
      {
        action: 'lambda:InvokeFunction',
        function: fn.name,
        principal: 'apigateway.amazonaws.com',
        sourceArn: pulumi.interpolate`${restApi.executionArn}/*/*`,
      },
      withProvider,
    );
    return { resource, method, integration };
  };

  const webhookRoute = route(
    'bot-webhook',
    restApi.rootResourceId,
    'webhook',
    'POST',
    webhookFunction,
    WEBHOOK_TIMEOUT_SECONDS,
  );
  const telegramResource = new aws.apigateway.Resource(
    'bot-telegram',
    {
      restApi: restApi.id,
      parentId: restApi.rootResourceId,
      pathPart: 'telegram',
    },
    withProvider,
  );
  const callbackRoute = route(
    'bot-callback',
    telegramResource.id,
    'callback',
    'GET',
    callbackFunction,
    CALLBACK_TIMEOUT_SECONDS,
  );

  const deployment = new aws.apigateway.Deployment(
    'bot',
    {
      restApi: restApi.id,
      // Hash the route configuration so a changed route redeploys the stage.
      triggers: {
        redeployment: pulumi.jsonStringify([
          webhookRoute.resource.pathPart,
          webhookRoute.method.httpMethod,
          webhookRoute.method.authorization,
          webhookRoute.integration.uri,
          webhookRoute.integration.timeoutMilliseconds,
          telegramResource.pathPart,
          callbackRoute.resource.pathPart,
          callbackRoute.method.httpMethod,
          callbackRoute.method.authorization,
          callbackRoute.integration.uri,
          callbackRoute.integration.timeoutMilliseconds,
        ]),
      },
    },
    {
      provider,
      dependsOn: [
        webhookRoute.method,
        webhookRoute.integration,
        callbackRoute.method,
        callbackRoute.integration,
      ],
    },
  );
  const apiStage = new aws.apigateway.Stage(
    'bot-stage',
    { restApi: restApi.id, deployment: deployment.id, stageName: stage },
    withProvider,
  );
  new aws.apigateway.MethodSettings(
    'bot-throttle',
    {
      restApi: restApi.id,
      stageName: apiStage.stageName,
      methodPath: '*/*',
      settings: {
        throttlingBurstLimit: THROTTLE.burstLimit,
        throttlingRateLimit: THROTTLE.rateLimit,
      },
    },
    withProvider,
  );

  return {
    restApi,
    webhookUrl: pulumi.interpolate`${apiStage.invokeUrl}/webhook`,
    callbackUrl,
    botTokenSecret,
    webhookSecret,
    telegramClientId: telegramClient.id,
  };
}
