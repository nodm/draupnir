import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handleWebhook, secretMatches, SECRET_HEADER } from './webhook';

const SECRET = 'correct-secret';

const privateMessage = {
  update_id: 42,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 777, type: 'private' },
    from: { id: 777, is_bot: false, first_name: 'Ann' },
    text: 'hi',
  },
};

function event(
  body: unknown,
  headers: Record<string, string> = { [SECRET_HEADER]: SECRET },
  extra: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    ...extra,
  } as APIGatewayProxyEvent;
}

function setup() {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  return { enqueue, deps: { secret: SECRET, enqueue } };
}

describe('handleWebhook secret check', () => {
  it('rejects a missing secret header without queuing', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(event(privateMessage, {}), deps);
    expect(result.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret without queuing', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(
      event(privateMessage, { [SECRET_HEADER]: 'wrong' }),
      deps,
    );
    expect(result.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('checks the secret before parsing the body', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(event('{not json', {}), deps);
    expect(result.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('matches the header name case-insensitively', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(
      event(privateMessage, { 'X-Telegram-Bot-Api-Secret-Token': SECRET }),
      deps,
    );
    expect(result.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('compares secrets of different lengths without throwing', () => {
    expect(secretMatches('short', 'a-much-longer-secret')).toBe(false);
    expect(secretMatches(undefined, 'x')).toBe(false);
    expect(secretMatches('same', 'same')).toBe(true);
  });
});

describe('handleWebhook queuing', () => {
  it('queues a genuine update grouped by chat and de-duplicated by update_id', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(event(privateMessage), deps);
    expect(result.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      groupId: '777',
      dedupId: '42',
      body: JSON.stringify(privateMessage),
    });
  });

  it('queues a button press using the chat of the message it belongs to', async () => {
    const { enqueue, deps } = setup();
    await handleWebhook(
      event({
        update_id: 43,
        callback_query: {
          id: 'q',
          from: { id: 777, is_bot: false, first_name: 'Ann' },
          chat_instance: 'c',
          data: 'confirm',
          message: {
            message_id: 2,
            date: 0,
            chat: { id: 777, type: 'private' },
          },
        },
      }),
      deps,
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: '777', dedupId: '43' }),
    );
  });

  it('decodes a base64 body', async () => {
    const { enqueue, deps } = setup();
    const body = Buffer.from(JSON.stringify(privateMessage)).toString('base64');
    await handleWebhook(
      event(body, { [SECRET_HEADER]: SECRET }, { isBase64Encoded: true }),
      deps,
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ body: JSON.stringify(privateMessage) }),
    );
  });

  it('acknowledges but drops updates from group chats', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(
      event({
        update_id: 44,
        message: { ...privateMessage.message, chat: { id: -5, type: 'group' } },
      }),
      deps,
    );
    expect(result.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acknowledges but drops updates that carry no chat', async () => {
    const { enqueue, deps } = setup();
    const result = await handleWebhook(event({ update_id: 45 }), deps);
    expect(result.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an authenticated body that is not an update', async () => {
    const { enqueue, deps } = setup();
    expect((await handleWebhook(event('{oops'), deps)).statusCode).toBe(400);
    expect((await handleWebhook(event({ hello: 1 }), deps)).statusCode).toBe(
      400,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('responds only after queuing, and does not wait for processing', async () => {
    // The handler has no processing dependency at all: success means "queued".
    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push('queued');
    });
    const result = await handleWebhook(event(privateMessage), {
      secret: SECRET,
      enqueue,
    });
    order.push(`responded:${result.statusCode}`);
    expect(order).toEqual(['queued', 'responded:200']);
  });

  it('surfaces a queue failure so Telegram retries the delivery', async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error('sqs down'));
    await expect(
      handleWebhook(event(privateMessage), { secret: SECRET, enqueue }),
    ).rejects.toThrow('sqs down');
  });
});
