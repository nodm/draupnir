import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { S3Client } from "@aws-sdk/client-s3";
import type {
	APIGatewayProxyResult,
	APIGatewayProxyWithCognitoAuthorizerEvent,
	Handler,
} from "aws-lambda";
import { UnauthenticatedError } from "./lib/auth";
import { loadDataApiConfigFromEnv } from "./lib/dataApi";
import {
	AccountNotFoundError,
	createPresignedUpload,
	loadUploadsBucketConfigFromEnv,
	type PresignedUploadInput,
} from "./lib/presignedUpload";

const dataApiClient = new RDSDataClient({});
const s3Client = new S3Client({});

export const handler: Handler<
	APIGatewayProxyWithCognitoAuthorizerEvent,
	APIGatewayProxyResult
> = async (event) => {
	const dataApiConfig = loadDataApiConfigFromEnv();
	const bucketConfig = loadUploadsBucketConfigFromEnv();
	const input = JSON.parse(event.body ?? "{}") as PresignedUploadInput;

	try {
		const upload = await createPresignedUpload(
			dataApiClient,
			dataApiConfig,
			s3Client,
			bucketConfig,
			event.requestContext.authorizer.claims,
			input,
		);

		return { statusCode: 201, body: JSON.stringify(upload) };
	} catch (error) {
		if (error instanceof UnauthenticatedError) {
			return {
				statusCode: 401,
				body: JSON.stringify({ error: error.message }),
			};
		}
		if (error instanceof AccountNotFoundError) {
			return {
				statusCode: 400,
				body: JSON.stringify({ error: error.message }),
			};
		}
		throw error;
	}
};
