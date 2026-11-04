import { randomUUID } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { CallbackQuery, Document, Message } from '@grammyjs/types';
import type { DataApiConfig } from 'shared';
import type { LinkedContext } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import { listMemberAccounts, type MemberAccount } from './accounts';
import { isCsvDocument, MAX_STATEMENT_BYTES } from './files';
import { createPendingUploads } from './pendingUploads';
import { sebTitleIbans } from './sebHeader';

export interface UploadDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  s3: S3Client;
  bucket: string;
}

// Callback data: `up:<pendingId>:<index into the offered accounts>`; 3 + 36 + 1
// + a few digits stays well under Telegram's 64-byte limit.
export const UPLOAD_CALLBACK_PREFIX = 'up';

const mb = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

const accountLabel = (a: MemberAccount) =>
  `${a.displayName} (…${a.iban.slice(-4)})`;

async function download(
  telegram: TelegramClient,
  fileId: string,
): Promise<Uint8Array | null> {
  const file = await telegram.getFile(fileId);
  if (!file.file_path) return null;
  const bytes = await telegram.downloadFile(file.file_path);
  return bytes.length > MAX_STATEMENT_BYTES ? null : bytes;
}

const owned = (accounts: MemberAccount[]) =>
  accounts.filter((a) => a.role === 'owner');

export async function handleDocument(
  ctx: LinkedContext,
  message: Message,
  document: Document,
  deps: UploadDeps,
): Promise<void> {
  const { telegram, chatId, sub } = ctx;

  if (!isCsvDocument(document)) {
    await telegram.sendMessage(
      chatId,
      'Only CSV exports are supported. Export your statement as CSV and send it again.',
    );
    return;
  }
  if ((document.file_size ?? 0) > MAX_STATEMENT_BYTES) {
    await telegram.sendMessage(
      chatId,
      `That file is larger than ${mb(MAX_STATEMENT_BYTES)}. Export a shorter period and send it again.`,
    );
    return;
  }

  const accounts = await listMemberAccounts(deps.client, deps.config, sub);
  const ownAccounts = owned(accounts);
  if (ownAccounts.length === 0) {
    await telegram.sendMessage(
      chatId,
      accounts.length > 0
        ? 'You can only view the accounts shared with you. An owner has to import statements, or create your own account first with /newaccount.'
        : 'You have no accounts yet. Create one with /newaccount, then send the statement again.',
    );
    return;
  }

  const bytes = await download(telegram, document.file_id);
  if (!bytes) {
    await telegram.sendMessage(
      chatId,
      `I could not read that file (limit ${mb(MAX_STATEMENT_BYTES)}). Try sending it again.`,
    );
    return;
  }

  // An SEB export names its account in the title line: use it when it points
  // at exactly one account the user owns, otherwise ask.
  const titleIbans = sebTitleIbans(new TextDecoder().decode(bytes));
  const matches = ownAccounts.filter(
    (a) => a.bank === 'seb' && titleIbans.includes(a.iban),
  );
  const pending = createPendingUploads(deps.client, deps.config, sub);
  const base = {
    chatId,
    messageId: message.message_id,
    telegramFileId: document.file_id,
    s3Key: null,
  };

  if (matches.length === 1) {
    const pendingId = await pending.create({
      ...base,
      offeredAccountIds: null,
    });
    await acceptUpload(ctx, deps, {
      account: matches[0] as MemberAccount,
      bytes,
      pendingId,
    });
    return;
  }

  const id = await pending.create({
    ...base,
    offeredAccountIds: ownAccounts.map((a) => a.id),
  });
  await telegram.sendMessage(chatId, 'Which account is this statement for?', {
    replyMarkup: {
      inline_keyboard: ownAccounts.map((a, index) => [
        {
          text: accountLabel(a),
          callback_data: `${UPLOAD_CALLBACK_PREFIX}:${id}:${index}`,
        },
      ]),
    },
  });
}

// Binds the pending row to its S3 key *before* writing the object, so the
// outcome can always be routed back to this chat once ingestion finishes. The
// claim is atomic: of two simultaneous button presses only one proceeds.
async function acceptUpload(
  ctx: LinkedContext,
  deps: UploadDeps,
  input: {
    account: MemberAccount;
    bytes: Uint8Array;
    pendingId: string;
  },
): Promise<void> {
  const pending = createPendingUploads(deps.client, deps.config, ctx.sub);
  const key = `uploads/${ctx.sub}/${input.account.id}/${randomUUID()}.csv`;
  const claimed = await pending.claim(input.pendingId, key);
  if (!claimed) {
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'That request expired or was already handled. Send the file again.',
    );
    return;
  }
  try {
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: 'text/csv',
        // A fresh random key: refuse to ever overwrite an existing object.
        IfNoneMatch: '*',
      }),
    );
  } catch (error) {
    await pending.discard(claimed.id);
    throw error;
  }
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Importing into ${accountLabel(input.account)}. I will report the result here.`,
  );
}

export async function handleUploadCallback(
  ctx: LinkedContext,
  query: CallbackQuery,
  data: string,
  deps: UploadDeps,
): Promise<void> {
  const { telegram, chatId, sub } = ctx;
  const [, pendingId, indexText] = data.split(':');
  const index = Number(indexText);
  if (!pendingId || !Number.isInteger(index)) return;

  // Whatever happens next, the buttons are spent.
  if (query.message) {
    await telegram
      .editMessageReplyMarkup(chatId, query.message.message_id)
      .catch(() => undefined);
  }

  const pending = createPendingUploads(deps.client, deps.config, sub);
  const offer = await pending.get(pendingId);
  const accountId = offer?.offeredAccountIds[index];
  // Re-check ownership now: it may have changed since the buttons were shown.
  const account = owned(
    await listMemberAccounts(deps.client, deps.config, sub),
  ).find((a) => a.id === accountId);
  if (!offer || !account) {
    await telegram.sendMessage(
      chatId,
      'That request expired or the account is no longer available. Send the file again.',
    );
    return;
  }

  const bytes = await download(telegram, offer.telegramFileId);
  if (!bytes) {
    await telegram.sendMessage(
      chatId,
      `I could not read that file (limit ${mb(MAX_STATEMENT_BYTES)}). Send it again.`,
    );
    return;
  }
  await acceptUpload(ctx, deps, { account, bytes, pendingId });
}
