import type { Migration } from './migration';

// FROZEN once applied. The accounts offered as buttons for a pending upload,
// so a button press resolves against what was shown rather than against a list
// that may have changed since (callback data is limited to 64 bytes, too small
// for an account id plus the upload id).
export const m0011: Migration = {
  id: '0011-pending-upload-offers',
  statements: [
    `ALTER TABLE bot_pending_uploads ADD COLUMN offered_account_ids jsonb`,
  ],
};
