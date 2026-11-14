# ingestion

This is the ingestion Lambda application (SQS-triggered), scaffolded with [Nx](https://nx.dev).

## Building

Run `nx build ingestion` to bundle the Lambda handler.

## Running unit tests

Run `nx test ingestion` to execute the unit tests via [Vitest](https://vitest.dev).

## Upload a statement by hand

`POST /uploads` on the ingestion API (stack output `ingestionInvokeUrl`) takes
`{"accountId": "<id>"}` for an account you own and answers `201` with a
presigned S3 POST:

```json
{
  "url": "https://<bucket>.s3.eu-north-1.amazonaws.com/",
  "fields": {
    "key": "uploads/…",
    "Content-Type": "text/csv",
    "Policy": "…",
    "X-Amz-Signature": "…"
  }
}
```

Send a `multipart/form-data` POST to `url` with every entry of `fields` as a
form field, then the file last, as `file`:

```bash
resp=$(curl -sf -X POST "$INGESTION_INVOKE_URL/uploads" \
  -H "Authorization: $ID_TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId": "<account id>"}')
args=()
while IFS=$'\t' read -r name value; do
  args+=(--form-string "$name=$value")
done < <(jq -r '.fields | to_entries[] | "\(.key)\t\(.value)"' <<<"$resp")
curl -sf "${args[@]}" -F "file=@statement.csv" "$(jq -r .url <<<"$resp")"
```

The object key is `fields.key`. The signed policy allows only that key,
`Content-Type: text/csv`, a file of 1 byte to 10 MiB, and expires 15 minutes
after it was issued. S3 refuses anything else before storing it:
`EntityTooLarge` or `EntityTooSmall` for the size, `AccessDenied` for an expired
policy or a changed field. A stored object is ingested without any further call.
