import { createHash, timingSafeEqual } from "node:crypto";
import type { Update } from "@grammyjs/types";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export interface QueuedUpdate {
	// FIFO ordering key: all updates of one chat are processed in order.
	groupId: string;
	// FIFO dedup key: Telegram retries carry the same update_id.
	dedupId: string;
	body: string;
}

export interface WebhookDeps {
	secret: string;
	// Telegram user ids allowed to use the bot. Empty means nobody (fail closed).
	allowedUserIds: ReadonlySet<number>;
	enqueue(update: QueuedUpdate): Promise<void>;
}

// Hashing first makes both inputs the same length, so neither the comparison
// time nor an early length check reveals anything about the secret.
export function secretMatches(
	provided: string | undefined,
	expected: string,
): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(provided ?? ""), digest(expected));
}

function header(
	headers: APIGatewayProxyEvent["headers"],
	name: string,
): string | undefined {
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

// The chat an update belongs to, for the kinds of update the bot handles.
export function chatOfUpdate(
	update: Update,
): { id: number; type: string } | undefined {
	return update.message?.chat ?? update.callback_query?.message?.chat;
}

// The user who sent the message or pressed the button.
export function senderOfUpdate(update: Update): number | undefined {
	return update.message?.from?.id ?? update.callback_query?.from?.id;
}

// Comma-separated numeric Telegram user ids. Missing or empty gives an empty
// set, which drops every update. A malformed entry throws so a typo fails the
// cold start instead of silently locking someone out.
export function parseAllowedUserIds(raw: string | undefined): Set<number> {
	const ids = new Set<number>();
	for (const part of (raw ?? "").split(",")) {
		const entry = part.trim();
		if (entry === "") continue;
		if (!/^\d+$/.test(entry) || !Number.isSafeInteger(Number(entry))) {
			throw new Error(
				"ALLOWED_TELEGRAM_USER_IDS must be comma-separated numeric Telegram user ids",
			);
		}
		ids.add(Number(entry));
	}
	return ids;
}

const ok = (): APIGatewayProxyResult => ({ statusCode: 200, body: "" });

export async function handleWebhook(
	event: APIGatewayProxyEvent,
	deps: WebhookDeps,
): Promise<APIGatewayProxyResult> {
	// Checked before the body is parsed or queued.
	if (!secretMatches(header(event.headers, SECRET_HEADER), deps.secret)) {
		return { statusCode: 401, body: "" };
	}

	const body = event.isBase64Encoded
		? Buffer.from(event.body ?? "", "base64").toString("utf8")
		: (event.body ?? "");

	let update: Update;
	try {
		update = JSON.parse(body) as Update;
	} catch {
		return { statusCode: 400, body: "" };
	}
	if (typeof update?.update_id !== "number") {
		return { statusCode: 400, body: "" };
	}

	// Access and cost guardrail: only the intended users reach the queue, and
	// so the worker and the database. Acknowledged (no Telegram retry), not
	// queued, and the update is not logged.
	const sender = senderOfUpdate(update);
	if (sender === undefined || !deps.allowedUserIds.has(sender)) {
		return ok();
	}

	// Private chats only. Anything else is acknowledged (so Telegram does not
	// retry it) and dropped.
	const chat = chatOfUpdate(update);
	if (chat?.type !== "private") {
		return ok();
	}

	await deps.enqueue({
		groupId: String(chat.id),
		dedupId: String(update.update_id),
		body,
	});
	return ok();
}
