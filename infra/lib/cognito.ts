import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
	Version: "2012-10-17",
	Statement: [
		{
			Effect: "Allow",
			Principal: { Service: "lambda.amazonaws.com" },
			Action: "sts:AssumeRole",
		},
	],
});

const LAMBDA_BASIC_EXECUTION_POLICY_ARN =
	"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

export interface AuthPool {
	userPool: aws.cognito.UserPool;
	userPoolClient: aws.cognito.UserPoolClient;
	domain: aws.cognito.UserPoolDomain;
}

export function createAuthPool(provider: aws.Provider): AuthPool {
	const config = new pulumi.Config();
	const google = new pulumi.Config("google");
	const withProvider = { provider };

	const preSignUpRole = new aws.iam.Role(
		"pre-sign-up-trigger",
		{
			assumeRolePolicy: LAMBDA_ASSUME_ROLE_POLICY,
		},
		withProvider,
	);

	new aws.iam.RolePolicyAttachment(
		"pre-sign-up-trigger-logs",
		{
			role: preSignUpRole.name,
			policyArn: LAMBDA_BASIC_EXECUTION_POLICY_ARN,
		},
		withProvider,
	);

	const preSignUpFunction = new aws.lambda.Function(
		"pre-sign-up-trigger",
		{
			role: preSignUpRole.arn,
			runtime: aws.lambda.Runtime.NodeJS24dX,
			handler: "preSignUpTrigger.handler",
			code: new pulumi.asset.FileArchive("../dist/infra/preSignUpTrigger"),
			environment: {
				variables: {
					ALLOWLISTED_EMAILS: config.requireSecret("allowlistedEmails"),
				},
			},
		},
		withProvider,
	);

	const userPool = new aws.cognito.UserPool(
		"users",
		{
			name: "draupnir-users",
			lambdaConfig: {
				preSignUp: preSignUpFunction.arn,
			},
		},
		withProvider,
	);

	new aws.lambda.Permission(
		"pre-sign-up-trigger-invoke",
		{
			action: "lambda:InvokeFunction",
			function: preSignUpFunction.name,
			principal: "cognito-idp.amazonaws.com",
			sourceArn: userPool.arn,
		},
		withProvider,
	);

	const googleIdentityProvider = new aws.cognito.IdentityProvider(
		"google",
		{
			userPoolId: userPool.id,
			providerName: "Google",
			providerType: "Google",
			providerDetails: {
				client_id: google.requireSecret("clientId"),
				client_secret: google.requireSecret("clientSecret"),
				authorize_scopes: "openid email profile",
			},
			attributeMapping: {
				email: "email",
				username: "sub",
			},
		},
		withProvider,
	);

	const userPoolClient = new aws.cognito.UserPoolClient(
		"app",
		{
			userPoolId: userPool.id,
			name: "draupnir-app",
			generateSecret: false,
			supportedIdentityProviders: ["Google"],
			allowedOauthFlowsUserPoolClient: true,
			allowedOauthFlows: ["code"],
			allowedOauthScopes: ["openid", "email", "profile"],
			callbackUrls: [
				config.get("callbackUrl") ?? "http://localhost:5173/callback",
			],
			logoutUrls: [config.get("logoutUrl") ?? "http://localhost:5173/"],
		},
		{ provider, dependsOn: [googleIdentityProvider] },
	);

	const domain = new aws.cognito.UserPoolDomain(
		"login",
		{
			userPoolId: userPool.id,
			domain: config.require("authDomainPrefix"),
			managedLoginVersion: 2,
		},
		withProvider,
	);

	return { userPool, userPoolClient, domain };
}
