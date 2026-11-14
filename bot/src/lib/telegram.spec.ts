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

  describe('sendMessage with HTML formatting', () => {
    const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, call: number) =>
      JSON.parse(
        (fetchImpl.mock.calls[call] as [string, RequestInit])[1].body as string,
      );
    const parseError = () =>
      jsonResponse(
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: can't parse entities: Unsupported start tag",
        },
        { status: 400 },
      );

    it('sends parse_mode only when asked', async () => {
      const fetchImpl = vi
        .fn()
        .mockImplementation(async () => jsonResponse({ ok: true, result: {} }));
      const client = createTelegramClient('T', fetchImpl);

      await client.sendMessage(1, '<b>hi</b>', { parseMode: 'HTML' });
      await client.sendMessage(1, 'a<b');

      expect(bodyOf(fetchImpl, 0).parse_mode).toBe('HTML');
      expect(bodyOf(fetchImpl, 1)).not.toHaveProperty('parse_mode');
    });

    it('resends once as plain text when Telegram cannot parse the markup', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(parseError())
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, result: { message_id: 3 } }),
        );
      const client = createTelegramClient('T', fetchImpl);

      const message = await client.sendMessage(
        1,
        '<b>A &lt;b&gt; &amp;amp</b> <code>x</code>',
        { parseMode: 'HTML' },
      );

      expect(message).toEqual({ message_id: 3 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(bodyOf(fetchImpl, 1)).toEqual({
        chat_id: 1,
        text: 'A <b> &amp x',
      });
    });

    it('does not resend on other errors', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked',
          },
          { status: 403 },
        ),
      );
      const client = createTelegramClient('T', fetchImpl);

      await expect(
        client.sendMessage(1, '<b>x</b>', { parseMode: 'HTML' }),
      ).rejects.toMatchObject({ errorCode: 403 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('propagates a failure of the plain-text resend', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(parseError())
        .mockResolvedValueOnce(
          jsonResponse(
            { ok: false, error_code: 500, description: 'boom' },
            { status: 500 },
          ),
        );
      const client = createTelegramClient('T', fetchImpl);

      await expect(
        client.sendMessage(1, '<b>x</b>', { parseMode: 'HTML' }),
      ).rejects.toMatchObject({ errorCode: 500 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
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
