import { randomBytes } from 'node:crypto';
import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { CallbackQuery } from '@grammyjs/types';
import {
  BANKS,
  canonicalizeIban,
  createAccount,
  DuplicateIbanError,
  formatMinorUnits,
  InvalidAccountInputError,
  InvalidBankError,
  isSupportedBank,
  isValidIban,
  isValidIsoDate,
  MAX_DISPLAY_NAME_LENGTH,
  parseMinorUnits,
  type DataApiConfig,
} from 'shared';
import { bankName, maskIban } from '../accounts/format';
import { createConversationStore } from '../conversations';
import type { CommandHandler, LinkedContext } from '../dispatcher';

export const NEW_ACCOUNT_KIND = 'newaccount';
export const BANK_CALLBACK_PREFIX = 'nb';
export const CONFIRM_CALLBACK_PREFIX = 'nc';

type Step =
  | 'bank'
  | 'iban'
  | 'currency'
  | 'name'
  | 'openedOn'
  | 'balance'
  | 'confirm';

interface Answers {
  bank?: string;
  iban?: string;
  currency?: string;
  displayName?: string;
  openedOn?: string;
  openingBalanceMinorUnits?: number;
}

interface State {
  // Ties the buttons to this dialogue: buttons of an earlier /newaccount
  // carry another nonce and are refused.
  nonce: string;
  step: Step;
  answers: Answers;
}

export interface NewAccountDeps {
  client: RDSDataClient;
  config: DataApiConfig;
  now?: () => Date;
}

const today = (deps: NewAccountDeps) =>
  (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);

const store = (deps: NewAccountDeps, sub: string) =>
  createConversationStore(deps.client, deps.config, sub);

const CANCEL_HINT = 'Send /cancel to stop.';

async function ask(
  ctx: LinkedContext,
  step: Step,
  answers: Answers,
  nonce: string,
): Promise<void> {
  const { telegram, chatId } = ctx;
  switch (step) {
    case 'bank':
      await telegram.sendMessage(chatId, 'Which bank is the account with?', {
        replyMarkup: {
          inline_keyboard: BANKS.map((bank) => [
            {
              text: bankName(bank),
              callback_data: `${BANK_CALLBACK_PREFIX}:${nonce}:${bank}`,
            },
          ]),
        },
      });
      return;
    case 'iban':
      await telegram.sendMessage(
        chatId,
        `What is the account's IBAN? ${CANCEL_HINT}`,
      );
      return;
    case 'currency':
      await telegram.sendMessage(
        chatId,
        'What is the account currency? Use a 3-letter code such as EUR.',
      );
      return;
    case 'name':
      await telegram.sendMessage(
        chatId,
        'What should the account be called? For example "SEB main".',
      );
      return;
    case 'openedOn':
      await telegram.sendMessage(
        chatId,
        'On what date do you know the balance? Use YYYY-MM-DD. Statements are checked against this starting point.',
      );
      return;
    case 'balance':
      await telegram.sendMessage(
        chatId,
        `What was the balance on ${answers.openedOn} in ${answers.currency}? For example 1250.50`,
      );
      return;
    case 'confirm':
      await telegram.sendMessage(chatId, summary(answers), {
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: 'Create account',
                callback_data: `${CONFIRM_CALLBACK_PREFIX}:${nonce}:yes`,
              },
              {
                text: 'Cancel',
                callback_data: `${CONFIRM_CALLBACK_PREFIX}:${nonce}:no`,
              },
            ],
          ],
        },
      });
  }
}

function summary(a: Answers): string {
  return [
    'Create this account?',
    `Name: ${a.displayName}`,
    `Bank: ${bankName(a.bank as string)}`,
    `IBAN: ${maskIban(a.iban as string)}`,
    `Currency: ${a.currency}`,
    `Balance on ${a.openedOn}: ${formatMinorUnits(a.openingBalanceMinorUnits as number, a.currency as string)} ${a.currency}`,
    '',
    'You will be its owner.',
  ].join('\n');
}

export function createNewAccountHandler(deps: NewAccountDeps): CommandHandler {
  return async (ctx) => {
    const nonce = randomBytes(4).toString('hex');
    await store(deps, ctx.sub).set<State>(NEW_ACCOUNT_KIND, {
      nonce,
      step: 'bank',
      answers: {},
    });
    await ask(ctx, 'bank', {}, nonce);
  };
}

export function createCancelHandler(deps: NewAccountDeps): CommandHandler {
  return async (ctx) => {
    const hadDialogue = await store(deps, ctx.sub).clear();
    await ctx.telegram.sendMessage(
      ctx.chatId,
      hadDialogue ? 'Cancelled.' : 'There is nothing to cancel.',
    );
  };
}

async function activeState(
  deps: NewAccountDeps,
  sub: string,
): Promise<State | null> {
  const conversation = await store(deps, sub).get<State>();
  return conversation?.kind === NEW_ACCOUNT_KIND ? conversation.state : null;
}

// Validates one typed answer. Returns an error to show (and stay on the same
// step), or the accepted value to store.
type Checked<T> = { error: string } | { value: T };

function checkAnswer(
  step: Step,
  text: string,
  answers: Answers,
  deps: NewAccountDeps,
): Checked<Partial<Answers>> {
  const value = text.trim();
  switch (step) {
    case 'iban': {
      const iban = canonicalizeIban(value);
      return isValidIban(iban)
        ? { value: { iban } }
        : {
            error:
              'That is not a valid IBAN (the format or the check digits are wrong). Check it and send it again.',
          };
    }
    case 'currency': {
      const currency = value.toUpperCase();
      return /^[A-Z]{3}$/.test(currency)
        ? { value: { currency } }
        : { error: 'Use a 3-letter currency code such as EUR or USD.' };
    }
    case 'name':
      return value.length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH
        ? { value: { displayName: value } }
        : {
            error: `Give the account a name of up to ${MAX_DISPLAY_NAME_LENGTH} characters.`,
          };
    case 'openedOn':
      if (!isValidIsoDate(value)) {
        return { error: 'Use a real date in the form YYYY-MM-DD.' };
      }
      return value <= today(deps)
        ? { value: { openedOn: value } }
        : {
            error: 'That date is in the future. Use today or an earlier date.',
          };
    case 'balance': {
      const minor = parseMinorUnits(value, answers.currency as string);
      return minor === null
        ? {
            error: `Send the balance as a number in ${answers.currency}, for example 1250.50 or -30.`,
          }
        : { value: { openingBalanceMinorUnits: minor } };
    }
    default:
      return { error: '' };
  }
}

const NEXT: Partial<Record<Step, Step>> = {
  iban: 'currency',
  currency: 'name',
  name: 'openedOn',
  openedOn: 'balance',
  balance: 'confirm',
};

// Handles free text while a /newaccount dialogue is open. Returns false when
// there is none, so the caller can fall back to the help reply.
export async function handleNewAccountText(
  ctx: LinkedContext,
  text: string,
  deps: NewAccountDeps,
): Promise<boolean> {
  const state = await activeState(deps, ctx.sub);
  if (!state) return false;

  if (state.step === 'bank' || state.step === 'confirm') {
    await store(deps, ctx.sub).set<State>(NEW_ACCOUNT_KIND, state);
    await ctx.telegram.sendMessage(
      ctx.chatId,
      `Please use the buttons above. ${CANCEL_HINT}`,
    );
    return true;
  }

  const checked = checkAnswer(state.step, text, state.answers, deps);
  if ('error' in checked) {
    // Same step again: nothing advances until the answer is valid. Writing the
    // state back keeps the idle expiry counting from this attempt.
    await store(deps, ctx.sub).set<State>(NEW_ACCOUNT_KIND, state);
    await ctx.telegram.sendMessage(ctx.chatId, checked.error);
    return true;
  }

  const answers = { ...state.answers, ...checked.value };
  const step = NEXT[state.step] as Step;
  await store(deps, ctx.sub).set<State>(NEW_ACCOUNT_KIND, {
    nonce: state.nonce,
    step,
    answers,
  });
  await ask(ctx, step, answers, state.nonce);
  return true;
}

export async function handleNewAccountCallback(
  ctx: LinkedContext,
  query: CallbackQuery,
  data: string,
  deps: NewAccountDeps,
): Promise<void> {
  const { telegram, chatId } = ctx;
  const [prefix, nonce, value] = data.split(':');
  const state = await activeState(deps, ctx.sub);

  // Whatever happens, these buttons are spent.
  if (query.message) {
    await telegram
      .editMessageReplyMarkup(chatId, query.message.message_id)
      .catch(() => undefined);
  }

  const expected: Step = prefix === BANK_CALLBACK_PREFIX ? 'bank' : 'confirm';
  if (!state || state.step !== expected || state.nonce !== nonce) {
    await telegram.sendMessage(
      chatId,
      'That request has expired. Send /newaccount to start again.',
    );
    return;
  }

  if (prefix === BANK_CALLBACK_PREFIX) {
    if (!value || !isSupportedBank(value)) return;
    const answers = { ...state.answers, bank: value };
    await store(deps, ctx.sub).set<State>(NEW_ACCOUNT_KIND, {
      nonce: state.nonce,
      step: 'iban',
      answers,
    });
    await ask(ctx, 'iban', answers, state.nonce);
    return;
  }

  if (value !== 'yes') {
    await store(deps, ctx.sub).clear();
    await telegram.sendMessage(chatId, 'Cancelled. No account was created.');
    return;
  }

  const a = state.answers;
  try {
    const created = await createAccount(deps.client, deps.config, ctx.sub, {
      bank: a.bank as string,
      iban: a.iban as string,
      currency: a.currency as string,
      displayName: a.displayName as string,
      openedOn: a.openedOn as string,
      openingBalanceMinorUnits: a.openingBalanceMinorUnits as number,
    });
    await store(deps, ctx.sub).clear();
    await telegram.sendMessage(
      chatId,
      `Created ${created.displayName} (${maskIban(created.iban)}). You are its owner. Send a statement CSV to import it.`,
    );
  } catch (error) {
    await store(deps, ctx.sub).clear();
    if (error instanceof DuplicateIbanError) {
      await telegram.sendMessage(
        chatId,
        'An account with that IBAN already exists, so none was created. Ask one of its owners to /share it with you.',
      );
      return;
    }
    if (
      error instanceof InvalidAccountInputError ||
      error instanceof InvalidBankError
    ) {
      await telegram.sendMessage(
        chatId,
        `Something in the answers was not accepted (${error.message}). Send /newaccount to try again.`,
      );
      return;
    }
    throw error;
  }
}
