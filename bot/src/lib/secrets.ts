import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const cache = new Map<string, Promise<string>>();

// Read once per cold start. A failed read is not cached, so the next
// invocation retries instead of failing until the container is recycled.
export function getSecretString(arn: string): Promise<string> {
  let value = cache.get(arn);
  if (!value) {
    value = client
      .send(new GetSecretValueCommand({ SecretId: arn }))
      .then((response) => {
        if (!response.SecretString) {
          throw new Error(`Secret ${arn} has no string value`);
        }
        return response.SecretString;
      })
      .catch((error: unknown) => {
        cache.delete(arn);
        throw error;
      });
    cache.set(arn, value);
  }
  return value;
}
