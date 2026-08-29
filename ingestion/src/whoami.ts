import type {
  APIGatewayProxyResult,
  APIGatewayProxyWithCognitoAuthorizerEvent,
  Handler,
} from 'aws-lambda';
import { extractWhoamiClaims } from './lib/whoami';

export const handler: Handler<
  APIGatewayProxyWithCognitoAuthorizerEvent,
  APIGatewayProxyResult
> = async (event) => {
  const claims = extractWhoamiClaims(event.requestContext.authorizer.claims);

  return {
    statusCode: 200,
    body: JSON.stringify(claims),
  };
};
