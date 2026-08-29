## Checklist

- [ ] Any new query against a user-owned table applies the ownership/grant
      predicate (`shared`'s `ownershipPredicate`, see ADR-0002) — no query
      against `owner_user_id`-bearing rows skips it
- [ ] Any new AWS resource added to `infra` passes `{ provider }` (the
      shared `aws.Provider` from `infra/lib/provider.ts`) so it gets the
      standard tags and the correct region
