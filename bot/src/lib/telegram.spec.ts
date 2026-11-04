import { createTelegramClient, TelegramApiError } from './telegram';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('createTelegramClient', () => {
  it('posts JSON to the method URL and returns the result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 9 } }));
    const client = createTelegramClient('TOKEN', fetchImpl);

    const message = await client.sendMessage(5, 'hello', {
      replyMarkup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'y' }]] },
    });

    expect(message).toEqual({ message_id: 9 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: 5,
      text: 'hello',
      reply_markup: {
        inline_keyboard: [[{ text: 'Yes', callback_data: 'y' }]],
      },
    });
  });

  it('throws TelegramApiError with the code and description, never the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description: 'message can’t be deleted',
        },
        { status: 400 },
      ),
    );
    const client = createTelegramClient('SECRET-TOKEN', fetchImpl);

    const error = await client.deleteMessage(1, 2).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ method: 'deleteMessage', errorCode: 400 });
    expect((error as Error).message).not.toContain('SECRET-TOKEN');
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>', { status: 502 }));
    const client = createTelegramClient('T', fetchImpl);

    await expect(client.sendChatAction(1, 'typing')).rejects.toMatchObject({
      errorCode: 502,
    });
  });

  it('clears inline buttons by default when editing the reply markup', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, result: true }));
    await createTelegramClient('T', fetchImpl).editMessageReplyMarkup(1, 2);

    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('downloads a file from the file endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const bytes = await createTelegramClient('T', fetchImpl).downloadFile(
      'documents/file_1.csv',
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.telegram.org/file/botT/documents/file_1.csv',
    );
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('reports a failed download as a TelegramApiError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('no', { status: 404 }));
    await expect(
      createTelegramClient('T', fetchImpl).downloadFile('x'),
    ).rejects.toMatchObject({ method: 'downloadFile', errorCode: 404 });
  });
});
