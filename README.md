# MySchedule — free Firebase Spark setup

A static scheduling UI on GitHub Pages, with Firebase Authentication and separate
Firestore records for each business. This branch uses **Spark**, not Cloud
Functions. There is no Firebase billing upgrade, paid backend or service-account
key requirement. Keep billing disabled. Free-service quotas still apply.

**The changes are a draft, not deployed.** Follow [SPARK_DEPLOYMENT.md](SPARK_DEPLOYMENT.md)
to publish the rules and matching client together and migrate the existing data.
The previous Functions approach has been removed from this branch.

## Local setup and checks

```sh
npm ci
npm start
```

Open http://localhost:8000. Real sign-in needs your configured Firebase project.
Public web settings belong in `config.js`; never put a Brevo key there.

```sh
npm run build
npm run lint
npm test
npm run test:emulators
```

Emulator tests use a disposable `demo-myschedule` project on loopback only and
require Java 17+ (the helper pins Firebase CLI 14.27.0). They test the actual
Firestore rules with authenticated clients and the same storage module used by
the website. They do not deploy, change billing or send email.

## Account flow

- Owners: business name, full name, email, password, then email verification.
- Employees: open the invitation, enter the invited email and a password (or sign
  in with an existing account), verify email, then enter the invited business.
- One sign-in form for everyone. No workplace code or second manager approval.
- Expiring, one-time invitations are consumed together with UID membership
  creation in an atomic transaction. Firestore rules enforce the email, role,
  business, expiry, revocation and membership checks independently of the UI.

## Data and deployment

- `spark-store.js` contains the shared Firestore client/storage implementation.
- `secure-backend.js` connects existing screens to Spark storage. Its historical
  name is retained for compatibility; it makes no Functions calls.
- `firestore.rules` protects each workplace, UID membership, private employee
  record and invitation. Directory data and published shifts have separate rules.
- `cloudflare-worker/worker-v147.mjs` is updated for the Spark schema. It reuses the
  existing email service with Firebase bearer authentication and rules-protected
  reads. If email is unavailable, an owner can copy/share the saved invitation
  link instead. No paid mail plan is required by this code.
- The legacy shared document becomes read-only for the explicitly pinned migration
  owner and inaccessible to everyone else. Migration preserves it as a private
  snapshot, creates separated records and requires employees to be re-invited.

Firestore listeners watch one revision document instead of repeatedly polling all
workplace data. Writes update only changed records. Spark has hard usage quotas;
if a free quota is exhausted, access may pause until reset rather than creating a
bill while billing remains disabled.

Live-project sign-in, email delivery, the email action URL and browser visual QA
still need release verification. Chromium download was unavailable in the coding
environment. Optional extensions missing from the original repository have not
been reconstructed. Employee time records still require managerial review.
