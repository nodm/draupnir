import {
	BatchExecuteStatementCommand,
	BeginTransactionCommand,
	CommitTransactionCommand,
	ExecuteStatementCommand,
	type Field,
	type RDSDataClient,
	RollbackTransactionCommand,
	type SqlParameter,
} from "@aws-sdk/client-rds-data";

// Narrow repository interface over RDS Data API per ADR-0003 — callers never
// touch @aws-sdk/client-rds-data directly, so a future move to a driver-based
// client stays contained to this module.

export interface DataApiConfig {
	resourceArn: string;
	secretArn: string;
	database: string;
}

export function loadDataApiConfigFromEnv(): DataApiConfig {
	const resourceArn = process.env["DB_CLUSTER_ARN"];
	const secretArn = process.env["DB_SECRET_ARN"];
	const database = process.env["DB_NAME"];

	if (!resourceArn || !secretArn || !database) {
		throw new Error(
			"Missing DB_CLUSTER_ARN/DB_SECRET_ARN/DB_NAME environment variables",
		);
	}

	return { resourceArn, secretArn, database };
}

export type SqlParameterValue = string | number | boolean | null;

export interface ExecuteResult {
	rows: Record<string, unknown>[];
	numberOfRecordsUpdated: number;
}

function toField(value: SqlParameterValue): Field {
	if (value === null) {
		return { isNull: true };
	}
	if (typeof value === "string") {
		return { stringValue: value };
	}
	if (typeof value === "boolean") {
		return { booleanValue: value };
	}
	return { doubleValue: value };
}

function toSqlParameters(
	parameters: Record<string, SqlParameterValue>,
): SqlParameter[] {
	return Object.entries(parameters).map(([name, value]) => ({
		name,
		value: toField(value),
	}));
}

export async function executeStatement(
	client: RDSDataClient,
	config: DataApiConfig,
	sql: string,
	parameters: Record<string, SqlParameterValue> = {},
	transactionId?: string,
): Promise<ExecuteResult> {
	const response = await client.send(
		new ExecuteStatementCommand({
			resourceArn: config.resourceArn,
			secretArn: config.secretArn,
			database: config.database,
			sql,
			parameters: toSqlParameters(parameters),
			transactionId,
			formatRecordsAs: "JSON",
		}),
	);

	return {
		rows: response.formattedRecords
			? JSON.parse(response.formattedRecords)
			: [],
		numberOfRecordsUpdated: response.numberOfRecordsUpdated ?? 0,
	};
}

// Runs one SQL statement once per parameter set in a single Data API call —
// used for the ingestion write path so a multi-thousand-row statement file
// doesn't cost one network round trip per row (see statement-ingestion-
// pipeline spec). Data API caps a single call's request at 4 MiB; callers
// are responsible for chunking parameterSets to stay under that.
export async function batchExecuteStatement(
	client: RDSDataClient,
	config: DataApiConfig,
	sql: string,
	parameterSets: Record<string, SqlParameterValue>[],
	transactionId?: string,
): Promise<void> {
	await client.send(
		new BatchExecuteStatementCommand({
			resourceArn: config.resourceArn,
			secretArn: config.secretArn,
			database: config.database,
			sql,
			parameterSets: parameterSets.map(toSqlParameters),
			transactionId,
		}),
	);
}

export async function beginTransaction(
	client: RDSDataClient,
	config: DataApiConfig,
): Promise<string> {
	const response = await client.send(
		new BeginTransactionCommand({
			resourceArn: config.resourceArn,
			secretArn: config.secretArn,
			database: config.database,
		}),
	);

	if (!response.transactionId) {
		throw new Error("BeginTransaction did not return a transactionId");
	}
	return response.transactionId;
}

export async function commitTransaction(
	client: RDSDataClient,
	config: DataApiConfig,
	transactionId: string,
): Promise<void> {
	await client.send(
		new CommitTransactionCommand({
			resourceArn: config.resourceArn,
			secretArn: config.secretArn,
			transactionId,
		}),
	);
}

export async function rollbackTransaction(
	client: RDSDataClient,
	config: DataApiConfig,
	transactionId: string,
): Promise<void> {
	await client.send(
		new RollbackTransactionCommand({
			resourceArn: config.resourceArn,
			secretArn: config.secretArn,
			transactionId,
		}),
	);
}
