import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

export function createAwsProvider(): aws.Provider {
  const awsConfig = new pulumi.Config('aws');

  return new aws.Provider('aws', {
    region: awsConfig.require('region'),
    defaultTags: {
      tags: {
        Project: 'draupnir',
        ManagedBy: 'pulumi',
        Environment: pulumi.getStack(),
      },
    },
  });
}
