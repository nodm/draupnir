## Context

See `proposal.md` - Why. Architecture is already decided by ADR-0004 (ingestion flow
shape), ADR-0003 (RDS Data API access), and ADR-0002 (ownership/auth pattern, already
implemented in `shared`) — this document applies those decisions to concrete schema,
modules, and Pulumi resources; it does not re-derive them.

## Goals / Non-Goals

**Goals:**
- Prove the full pipeline end-to-end for CSV upload, all three banks: presigned upload
  → S3 → SQS → Lambda → parser → dedup → `transactions`.
- Define `accounts`/`transactions` schema once, in a shape the (deferred) email channel
  and future read endpoints can reuse without migration.

**Non-Goals:**
- SES email ingestion channel — deferred; see proposal's Out of scope.
- Any read/list API over `accounts`/`transactions` — this change is write-only
  (upload → rows land in the DB); a future change adds querying.
- Account creation UX beyond the minimal `POST /accounts` endpoint (no update/
  delete/list, no UI polish) — see Decisions below for what account resolution
  actually requires given a SEB file can span multiple accounts.

## Decisions

**Schema location**: `accounts`/`transactions` DDL lives in `shared`, alongside
`SHARE_GRANTS_TABLE_DDL`, as exported SQL-string constants applied the same way. Keeps
one place owning all table definitions consistent with the existing pattern rather than
introducing a migrations framework for a 2-user app.

**dedup_key type and storage**: `text`, computed by the parser (not a DB-generated
column), so the hash algorithm is a parser-layer concern per `bank-statement-parsers`
spec, not baked into SQL. `UNIQUE` index on `transactions(dedup_key)`.

**Account resolution during ingestion — keyed by account, overridable per row**:
confirmed against a real (anonymized) SEB sample
(`ingestion/src/lib/parsers/__fixtures__/seb.csv`) that a single SEB export file can
contain multiple accounts' transactions, each row self-describing its own IBAN
(`SĄSKAITOS NR` column). Revolut and monobank exports carry no per-row IBAN — one
file is one account. This means "resolve the account from the S3 key's `bank`
segment" (the original plan) doesn't hold for SEB. Resolution is now two-layered:

- The presigned-upload key becomes `uploads/{sub}/{accountId}/{uuid}.csv` — the
  caller selects an *account* (not just a bank) at upload time; `accountId` must
  already exist and be owned by `sub`, checked when the presigned URL is issued (not
  deferred to the Lambda). The account's `bank` column (not the S3 key) drives parser
  dispatch — so `bank` is looked up, not embedded in the key.
- Each parser's `NormalizedRow` carries an `iban` field. SEB's parser sets it per row
  from `SĄSKAITOS NR`; Revolut and monobank always set it to the upload-selected
  account's own IBAN, since their export format has nothing else to key from.
- The ingestion Lambda resolves each row's target `accounts` row by
  `WHERE owner_user_id = :sub AND iban = :row_iban` — this can differ from the
  account selected at upload time when SEB's file spans multiple accounts, as long
  as every IBAN in the file already has an `accounts` row owned by the same caller.
- If any row's IBAN has no matching `accounts` row, the **whole file** fails
  processing (same retry/DLQ path as a parse error) — consistent with the existing
  one-Data-API-transaction-per-file, all-or-nothing decision; no partial commits
  while some rows wait on an account to be created.

**Account creation**: a new authenticated endpoint on the `ingestion` REST API,
`POST /accounts`, accepting `{ bank, iban, currency, displayName }`. `owner_user_id`
is taken only from the Cognito claim, same rule as the presigned-upload endpoint.
`iban` is `UNIQUE` (a real IBAN identifies exactly one account). This is a minimal
create-only endpoint — no update/delete/list in this change (Non-Goals).

**Parser interface**: one shared TypeScript interface,
`parseStatement(fileContents: string, uploadAccountIban: string) -> NormalizedRow[]`,
each bank module implements it (`uploadAccountIban` is the account selected at
upload time — SEB's parser may override it per row, Revolut/monobank's always use
it as-is). The ingestion Lambda handler is bank-agnostic: it resolves `bank` from
the upload-selected account, then looks up the parser from a small dispatch map.
`NormalizedRow` carries `iban`, `postedDate`, `amountMinorUnits`, `currency`,
`description` (post-normalization), and `dedupKey` already computed — the write
path never re-derives it.

**occurrence_index computation**: computed per-file, in-memory, by grouping parsed
rows (pre-hash) by their other four fields and assigning rank order — not a DB
sequence or window function, since it only needs to be consistent within one file's
single parse pass, per the `bank-statement-parsers` spec's re-parse-stability
scenario.

**Module placement**: `ingestion/src/lib/parsers/{seb,revolut,monobank}.ts`,
`ingestion/src/lib/dedupKey.ts` (shared normalization helpers used by all three
parsers), new SQS-triggered handler alongside the existing HTTP handler in
`ingestion/src/handler.ts`'s pattern. Presigned-URL issuance is a new route on the
existing `ingestion` REST API (`infra/lib/ingestionApi.ts`), not a new API Gateway
resource.

**FX metadata extraction (SEB only)**: SEB's card-purchase rows embed the original
(pre-conversion) currency/amount and the FX fee (amount + percent) as free text
inside `MOKĖJIMO PASKIRTIS`, e.g. `299.00 NOK(25.67 EUR + mokestis 0.68
EUR(2.65%))` — unlike monobank, there is no dedicated column to read this from. The
SEB parser regex-extracts this pattern per row; when absent (domestic EUR purchases,
transfers), the four FX fields are left unset. `NormalizedRow` and the
`transactions` schema carry these fields generically (nullable, bank-agnostic) so a
future parser needing the same shape doesn't require a schema change — but only SEB
populates them in this change.

## Risks / Trade-offs

- **Account creation is separate from upload, not implicit** → a first-time upload for
  a (user, bank) pair with no existing `accounts` row fails and DLQs rather than
  auto-creating one from the upload request. Mitigation: the new `POST /accounts`
  endpoint makes this a one-step fix the user takes before uploading, not a manual DB
  operation.
- **Hash-fallback dedup's known limitation** (documented in memory and ADR-0004): a
  true duplicate at a re-upload overlap boundary can slip past dedup for Revolut/
  monobank if `occurrence_index` doesn't line up across two independent parses of
  files with different row ordering. Not solved here — accepted, matching ADR-0004.
- **Whole-file failure on one unresolvable IBAN** → in a multi-account SEB file,
  one row for an account the user hasn't created yet DLQs the entire file, including
  rows for accounts that do exist. Mitigation: acceptable at 2-user scale — the fix
  is creating the missing account and re-uploading; a partial-write alternative
  would break the existing one-transaction-per-file guarantee for a rare case.
- **One Lambda for three parsers** → a bug in one bank's parser can affect the shared
  Lambda's deploy/blast radius for the others. Mitigation: matches ADR-0004's explicit
  "one ingestion Lambda for all banks" decision; each parser is unit-tested in
  isolation via its fixture.
