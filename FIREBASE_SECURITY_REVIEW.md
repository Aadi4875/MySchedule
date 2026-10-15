# Release blocker: deployed Firestore authorization

The user supplied the currently deployed rules on 15 October 2026. This review is based on those rules and the repository source; no live exploitation or production data access was performed.

## Confirmed authorization gaps

1. `/apps/myschedule_public_launch` grants read, create and update whenever `request.auth != null`. This includes accounts without verified email and accounts with no approved business membership. Every such account can read the entire shared state document and replace its contents. UI role checks and transactions in browser JavaScript do not constrain a modified client.
2. Because all businesses are stored in that document, an authorized document read exposes every business in it. Firestore rules cannot redact individual fields or array entries from a returned document.
3. `publicInvitations` creation checks only the caller's self-declared inviterUid, tokenHash/document ID equality and allowed keys. It does not verify an active manager membership for the claimed business.
4. `publicInvitations` updates allow any authenticated caller who knows a document ID to change its status, regardless of the invitation's business or recipient. This is preview/status tampering; changing the preview alone is not authoritative membership acceptance.
5. The comment promising a random SHA-256 ID is not enforced by the rules. Equality of tokenHash and document ID does not establish randomness or even SHA-256 formatting.
6. Denying browser access to secureBusinesses and secureInvitations does not protect the separately writable legacy document.

## Required implementation

- Move authoritative business data into separate business documents/collections, or expose it only through authenticated backend functions that return the caller's authorized data. Do not return the shared multi-business document to browsers.
- Keep membership creation, roles, approval state, invitation creation/revocation and acceptance under server authorization. Invitation acceptance must check verified Firebase UID/email, token hash, business, pending state, expiry and replacement, then consume it atomically.
- Authorize roster/data reads and writes by business membership and role. Employees must not be able to edit other employees, managers, roles, invitation state or another business.
- Generate previews from authorized invitation operations. Restrict preview updates to the backend; a preview must never grant membership.
- Migrate the legacy records with an administrative process, preserving IDs and validating existing owner/employee bindings before cutover. Do not automatically trust all existing active roles: the old rules allowed authenticated clients to edit them.
- Remove browser access to the legacy shared document only when the matching backend and client changes are deployed together. A deny-all replacement applied now would interrupt the existing application.
- Test rules and backend authorization in the emulator using unverified users, users without memberships, employees and owners across two businesses. Then run a disposable-account integration check against the deployed project.

## Deployment requirements

The frontend simplification in this PR remains a draft. The available GitHub connection cannot deploy Firebase rules or functions. A Firebase plugin connection has been requested so the actual project, deployed configuration and supported deployment capabilities can be inspected. Existing deployed Functions, if any, must be retrieved before replacing them.

The Authentication email action URL must point to `https://aadi4875.github.io/MySchedule/` after the handler assets are deployed. That setting fixes the separate verification-page redirect; it does not repair database authorization.

References:
- https://firebase.google.com/docs/firestore/security/get-started
- https://firebase.google.com/docs/firestore/security/rules-fields#allowing_read_access_only_for_specific_fields
- https://firebase.google.com/docs/auth/custom-email-handler
