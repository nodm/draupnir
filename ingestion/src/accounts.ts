import type {
  APIGatewayProxyResult,
  APIGatewayProxyWithCognitoAuthorizerEvent,
  Handler,
} from 'aws-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { UnauthenticatedError, requireSub } from './lib/auth';
import {
  createAccount,
  DuplicateIbanError,
  InvalidAccountInputError,
  InvalidBankError,
  loadDataApiConfigFromEnv,
  type CreateAccountInput,
} from 'shared';

const client = new RDSDataClient({});

export const handler: Handler<
  APIGatewayProxyWithCognitoAuthorizerEvent,
  APIGatewayProxyResult
> = async (event) => {
  const config = loadDataApiConfigFromEnv();
  const input = JSON.parse(event.body ?? '{}') as CreateAccountInput;

  try {
    const account = await createAccount(
      client,
      config,
      requireSub(event.requestContext.authorizer.claims),
      input,
    );

    return { statusCode: 201, body: JSON.stringify(account) };
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: error.message }),
      };
    }
    if (
      error instanceof InvalidBankError ||
      error instanceof DuplicateIbanError ||
      error instanceof InvalidAccountInputError
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: error.message }),
      };
    }
    throw error;
  }
};
