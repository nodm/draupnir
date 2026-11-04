import type {
  File as TelegramFile,
  InlineKeyboardMarkup,
  Message,
} from '@grammyjs/types';

// The chat actions the bot uses (the full list is in the Bot API docs).
export type ChatAction = 'typing' | 'upload_document';

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    description: string,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = 'TelegramApiError';
  }
}

export interface SendMessageOptions {
  replyMarkup?: InlineKeyboardMarkup;
}

export interface TelegramClient {
  sendMessage(
    chatId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<Message>;
  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<TelegramFile>;
  downloadFile(filePath: string): Promise<Uint8Array>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendChatAction(chatId: number, action: ChatAction): Promise<void>;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

const API = 'https://api.telegram.org';

// A thin fetch wrapper over the few Bot API methods the bot uses. The token is
// only ever placed in the request URL, never in an error message or log.
export function createTelegramClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    let payload: ApiResponse<T> | undefined;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
      payload = undefined;
    }
    if (!response.ok || !payload?.ok) {
      throw new TelegramApiError(
        method,
        payload?.error_code ?? response.status,
        payload?.description ?? response.statusText,
      );
    }
    return payload.result as T;
  }

  return {
    sendMessage: (chatId, text, options) =>
      call<Message>('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: options?.replyMarkup,
      }),
    editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
      await call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
      });
    },
    getFile: (fileId) => call<TelegramFile>('getFile', { file_id: fileId }),
    downloadFile: async (filePath) => {
      const response = await fetchImpl(`${API}/file/bot${token}/${filePath}`);
      if (!response.ok) {
        throw new TelegramApiError(
          'downloadFile',
          response.status,
          response.statusText,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    deleteMessage: async (chatId, messageId) => {
      await call('deleteMessage', { chat_id: chatId, message_id: messageId });
    },
    sendChatAction: async (chatId, action) => {
      await call('sendChatAction', { chat_id: chatId, action });
    },
  };
}
