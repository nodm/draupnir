import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { CallbackQuery, Document, Message } from '@grammyjs/types';
import type { DataApiConfig } from 'shared';
import type { LinkedContext } from '../dispatcher';
import type { TelegramClient } from '../telegram';
import { listMemberAccounts, type MemberAccount } from './accounts';
import { isCsvDocument, MAX_STATEMENT_BYTES } from './files';
import { isPreconditionFailed, statementObjectKey } from './objectKey';
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
    const account = matches[0] as MemberAccount;
    // Derived from the Telegram message, so a retried update writes to the same
    // key and cannot upload the file a second time.
    const key = statementObjectKey(
      sub,
      account.id,
      `${chatId}:${message.message_id}:${document.file_unique_id}`,
    );
    await pending.create({ ...base, offeredAccountIds: null, s3Key: key });
    await putAndAcknowledge(ctx, deps, account, key, bytes);
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

// Writes the object and tells the user, once. The upload is idempotent end to
// end: the key is fixed by what is being uploaded, and a repeat write is
// refused by S3 (412). So a failure at any point can simply be retried:
//  - PutObject threw but the object may exist: retry hits 412 = already done;
//  - the object and pending row are committed but the acknowledgement failed:
//    retry hits 412, and the user still gets the outcome report later.
// The pending row stays bound to its key through failures, so the outcome can
// always be routed back to this chat.
async function putAndAcknowledge(
  ctx: LinkedContext,
  deps: UploadDeps,
  account: MemberAccount,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'text/csv',
        IfNoneMatch: '*',
      }),
    );
  } catch (error) {
    if (isPreconditionFailed(error)) return; // an earlier attempt wrote it
    throw error;
  }
  await ctx.telegram.sendMessage(
    ctx.chatId,
    `Importing into ${accountLabel(account)}. I will report the result here.`,
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

  // Bound to this upload and account; an upload already bound to another
  // account (a different button pressed first) is refused.
  const key = statementObjectKey(sub, account.id, `pending:${pendingId}`);
  if (!(await pending.claim(pendingId, key))) {
    await telegram.sendMessage(
      chatId,
      'That request was already handled with a different account. Send the file again to redo it.',
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
  await putAndAcknowledge(ctx, deps, account, key, bytes);
}
