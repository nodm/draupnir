import { getAccountCoverageTool } from './getAccountCoverage';
import { listAccounts } from './listAccounts';
import { listTransactions } from './listTransactions';
import { summarizeTransactions } from './summarizeTransactions';

export * from './dataTool';
export { listAccounts, type AccountSummary } from './listAccounts';
export {
  getAccountCoverageTool,
  type AccountCoverageResult,
} from './getAccountCoverage';
export {
  listTransactions,
  type ListTransactionsResult,
  type TransactionItem,
} from './listTransactions';
export {
  summarizeTransactions,
  type SummarizeTransactionsResult,
  type SummaryGroup,
} from './summarizeTransactions';

// Every read-only data tool, for a surface to register.
export const DATA_TOOLS = [
  listAccounts,
  listTransactions,
  summarizeTransactions,
  getAccountCoverageTool,
] as const;
