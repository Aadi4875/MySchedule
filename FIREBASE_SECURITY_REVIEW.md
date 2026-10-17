# Release blocker: deployed Firestore authorization

The user supplied the currently deployed rules on 15 October 2026. This review is based on those rules and the repository source; no live exploitation or production data access was performed.

## Confirmed authorization gaps

1. `/apps/myschedule_public_launch` grants read, create and update whenever `request.auth != null`. This includes accounts without verified email and accounts with no approved business membership. Every such account can read the entire shared state document and replace its contents. UI role checks and transactions in browser JavaScript do not constrain a modified client.
2. Because all businesses are stored in that document, an authorized document read exposes every business in it. Firestore rules cannot redact individual fields or array entries from a returned document.
3. `publicInvitations` creation checks only the caller's self-declared inviterUid, tokenHash/document ID equality and allowed keys. It does not verify an active manager membership for the claimed business.
4. `publicInvitations` updates allow any authenticated caller who knows a document ID to change its status, regardless of the invitation's business or recipient. This is preview/status tampering; changing the preview alone is not authoritative membership acceptance.
5. The comment promising a random SHA-256 ID is not enforced by the rules. Equality of tokenHash and document ID does not establish randomness or even SHA-256 formatting.
6. Denying browser access to secureBusinesses and secureInvitations does not protect the separately writable legacy document.

## Implemented Spark-compatible replacement (not yet deployed)

The user requires a free plan and declined billing upgrades. The Functions approach
has been removed. `spark-store.js` stores each workplace in its own namespace,
with UID membership documents, separate private profiles and limited directories,
record-level authorization and atomically consumed invitations. The browser SDK
runs transactions, but Firestore rules independently enforce every access grant.
Rules protect the database even if the browser JavaScript is modified.

The legacy shared document is read-only for one explicitly pinned, verified
migration owner, and inaccessible to everyone else. It is never edited by migration.
A random new workplace namespace is created for each reviewed owned business;
existing staff must be re-invited because old role data could have been modified
under the previous rules. The temporary legacy-read exception can be removed after
migration. See SPARK_DEPLOYMENT.md for the required coordinated cutover and tests.

The existing Cloudflare email Worker now uses the same per-workplace Firestore
rules with the Firebase caller token. It has no Admin SDK credentials. Sharing a
saved invitation link manually works without any email service or paid plan.

No production rule, billing setting, email template, Worker or business record has
been changed by writing this source. Live-project verification remains required.

References:
- https://firebase.google.com/docs/firestore/security/rules-fields
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/auth/custom-email-handler
