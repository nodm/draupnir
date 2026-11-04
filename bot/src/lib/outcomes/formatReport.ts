import type { OutcomeReason, StatementOutcomeMessage } from 'shared';

// Telegram rejects messages over 4096 characters; stay well under and cap the
// list so a file with thousands of bad rows still gets a readable answer.
const MAX_REASONS = 15;
const MAX_LENGTH = 3800;

// The pipeline's messages mostly start with "Row N" already ("Row 37: balance
// … does not follow …"); add the prefix only to a row-tagged one that lacks it.
function line(reason: OutcomeReason): string {
  const prefixed =
    reason.row !== undefined &&
    !new RegExp(`^Row ${reason.row}\\b`, 'i').test(reason.message);
  return `• ${prefixed ? `Row ${reason.row}: ` : ''}${reason.message}`;
}

// `omitted` = reasons the sender already left out to keep the message small.
function bullets(reasons: OutcomeReason[], omitted = 0): string[] {
  const shown = reasons.slice(0, MAX_REASONS).map(line);
  const more = reasons.length - shown.length + omitted;
  if (more > 0) shown.push(`…and ${more} more.`);
  return shown;
}

function clip(text: string): string {
  return text.length <= MAX_LENGTH ? text : `${text.slice(0, MAX_LENGTH)}…`;
}

export function formatOutcomeReport(message: StatementOutcomeMessage): string {
  if (message.status === 'rejected') {
    return clip(
      [
        '❌ This file was not imported. It was rejected:',
        ...bullets(message.reasons, message.omittedReasonCount),
        '',
        'Fix the problem and send the file again.',
      ].join('\n'),
    );
  }

  const period =
    message.period?.from && message.period.to
      ? ` covering ${message.period.from} to ${message.period.to}`
      : '';
  const count =
    message.newTransactionCount === 0
      ? 'No new transactions (everything in the file was already imported)'
      : `${message.newTransactionCount} new transaction${message.newTransactionCount === 1 ? '' : 's'} imported`;

  const warnings = Object.values(message.warningsByAccount).flat();
  return clip(
    [
      `✅ ${count}${period}.`,
      ...(warnings.length > 0
        ? [
            '',
            '⚠️ Heads up:',
            ...bullets(warnings, message.omittedWarningCount),
          ]
        : []),
    ].join('\n'),
  );
}
