## Checklist

- [ ] Any new query against a user-owned table applies the ownership/grant
      predicate (`shared`'s `ownershipPredicate`, see ADR-0002) — no query
      against `owner_user_id`-bearing rows skips it
- [ ] Any new table has `ENABLE ROW LEVEL SECURITY` and policies in its
      migration (a guard test fails otherwise); every `SECURITY DEFINER`
      function pins `search_path = pg_catalog, pg_temp`, schema-qualifies its
      references, and revokes `EXECUTE` from `PUBLIC`
- [ ] Application database access goes through `withCaller(sub, fn)`, never a
      bare `executeStatement` outside it
- [ ] Any new AWS resource added to `infra` passes `{ provider }` (the
      shared `aws.Provider` from `infra/lib/provider.ts`) so it gets the
      standard tags and the correct region
