import { m0001 } from './0001-initial-schema';
import { m0002 } from './0002-statement-data-model';
import { m0003 } from './0003-import-order-and-raw-row-account';
import { m0004 } from './0004-backfill-import-seq';
import { m0005 } from './0005-row-level-security';
import { m0006 } from './0006-rls-review-fixes';
import { m0007 } from './0007-restrict-file-account-links';
import { m0008 } from './0008-link-requires-upload-account-owner';
import { m0009 } from './0009-bot';
import { m0010 } from './0010-bot-link-helpers';
import { m0011 } from './0011-pending-upload-offers';
import { m0012 } from './0012-recorded-outcome-lookup';
import { m0013 } from './0013-member-chat-lookup';
import { m0014 } from './0014-record-bot-message';
import { m0015 } from './0015-claim-bot-messages';
import { m0016 } from './0016-unreported-outcomes';
import { m0017 } from './0017-transactions-indexes';
import { m0018 } from './0018-account-balances';
import type { Migration } from './migration';

// Append-only, ascending by id. Never edit or remove an applied migration.
export const MIGRATIONS: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
];
