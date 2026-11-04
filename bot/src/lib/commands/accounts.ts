import type { RDSDataClient } from '@aws-sdk/client-rds-data';
import { getAccountCoverage, type DataApiConfig } from 'shared';
import type { CommandHandler, LinkedContext } from '../dispatcher';
import { listMemberAccounts, type MemberAccount } from '../memberAccounts';
import {
  accountLabel,
  formatAccountList,
  formatCoverage,
} from '../accounts/format';

export interface AccountCommandDeps {
  client: RDSDataClient;
  config: DataApiConfig;
}

export const COVERAGE_CALLBACK_PREFIX = 'cov';

// Every account the caller belongs to, with the date its history is reconciled
// up to. A coverage that cannot be read shows as "not reconciled" rather than
// hiding the account.
export function createAccountsHandler(
  deps: AccountCommandDeps,
): CommandHandler {
  return async (ctx) => {
    const accounts = await listMemberAccounts(
      deps.client,
      deps.config,
      ctx.sub,
    );
    const summaries = await Promise.all(
      accounts.map(async (account) => ({
        account,
        reconciledUpTo: await getAccountCoverage(
          deps.client,
          deps.config,
          ctx.sub,
          account.id,
        )
          .then((c) => c.reconciledUpTo)
          .catch(() => null),
      })),
    );
    await ctx.telegram.sendMessage(ctx.chatId, formatAccountList(summaries));
  };
}

async function sendCoverage(
  ctx: LinkedContext,
  deps: AccountCommandDeps,
  account: MemberAccount,
): Promise<void> {
  const coverage = await getAccountCoverage(
    deps.client,
    deps.config,
    ctx.sub,
    account.id,
  );
  await ctx.telegram.sendMessage(ctx.chatId, formatCoverage(account, coverage));
}

// One account: show it. Several: ask which. The button carries the account id
// (4 + 36 bytes); membership is re-checked when it is pressed.
export function createCoverageHandler(
  deps: AccountCommandDeps,
): CommandHandler {
  return async (ctx) => {
    const accounts = await listMemberAccounts(
      deps.client,
      deps.config,
      ctx.sub,
    );
    if (accounts.length === 0) {
      await ctx.telegram.sendMessage(
        ctx.chatId,
        'You have no accounts yet. Create one with /newaccount.',
      );
      return;
    }
    if (accounts.length === 1) {
      await sendCoverage(ctx, deps, accounts[0] as MemberAccount);
      return;
    }
    await ctx.telegram.sendMessage(ctx.chatId, 'Coverage of which account?', {
      replyMarkup: {
        inline_keyboard: accounts.map((a) => [
          {
            text: accountLabel(a),
            callback_data: `${COVERAGE_CALLBACK_PREFIX}:${a.id}`,
          },
        ]),
      },
    });
  };
}

export async function handleCoverageCallback(
  ctx: LinkedContext,
  data: string,
  deps: AccountCommandDeps,
): Promise<void> {
  const accountId = data.slice(COVERAGE_CALLBACK_PREFIX.length + 1);
  // Only an account the caller belongs to can be found here.
  const account = (
    await listMemberAccounts(deps.client, deps.config, ctx.sub)
  ).find((a) => a.id === accountId);
  if (!account) {
    await ctx.telegram.sendMessage(
      ctx.chatId,
      'That account is not available to you any more.',
    );
    return;
  }
  await sendCoverage(ctx, deps, account);
}
