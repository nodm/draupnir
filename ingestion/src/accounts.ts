import type {
  APIGatewayProxyResult,
  APIGatewayProxyWithCognitoAuthorizerEvent,
  Handler,
} from 'aws-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import {
  createAccount,
  DuplicateIbanError,
  InvalidBankError,
  type CreateAccountInput,
} from './lib/accounts';
import { UnauthenticatedError } from './lib/auth';
import { loadDataApiConfigFromEnv } from './lib/dataApi';

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
      event.requestContext.authorizer.claims,
      input,
    );

    return { statusCode: 201, body: JSON.stringify(account) };
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return { statusCode: 401, body: JSON.stringify({ error: error.message }) };
    }
    if (error instanceof InvalidBankError || error instanceof DuplicateIbanError) {
      return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    }
    throw error;
  }
};
