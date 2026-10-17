# MySchedule

Static workforce scheduling UI with Firebase Authentication and a server-authorized
Cloud Functions backend. Node.js 22 is the production backend runtime. GitHub Pages
hosts the browser files; Firebase hosts the functions and private Firestore data.

**This draft branch requires a coordinated Firebase deployment before publishing.**
Follow [FIREBASE_DEPLOYMENT.md](FIREBASE_DEPLOYMENT.md). It replaces the legacy
browser-readable multi-business document with authenticated callable access to
that private storage. Creating or merging this PR does not deploy Firebase.

## Run the UI locally

```sh
npm ci
npm start
```

Open http://localhost:8000. The local server builds and serves only `dist`. Real
sign-in needs the configured Firebase project and a deployed backend. There is no
insecure local-data fallback. For offline UI tests use the test fixtures.

`config.js` supports public Firebase and Google Places settings. The normal
built-in Firebase web configuration remains the default. Do not put server or
mail credentials in public configuration. Session credentials and passwords are
handled by Firebase Authentication.

## Checks

```sh
npm ci --prefix functions
npm run build
npm run lint
npm test
```

Unit tests cover backend authorization, invitation expiry/replacement/replay,
business isolation, protected roles, server-side removal, optimistic concurrency,
owner verification, email actions, and the real frontend-to-backend state shape.
DOM tests also render owner, manager and employee routes with network disabled.
Build checks syntax and every referenced local asset before copying to `dist`.

Auth/Firestore/Functions emulator integration tests use the disposable
`demo-myschedule` project and loopback hosts only. Run `npm run test:emulators` after installing the backend dependencies. Details are
in [FIREBASE_DEPLOYMENT.md](FIREBASE_DEPLOYMENT.md). These test callable handlers and denial of direct database reads/writes. The
`--direct` mode exercises the actual handlers with Auth/Firestore emulators when
the full Functions HTTP emulator is unavailable; HTTP/CORS still need verification. They do not send real emails
or deploy anything to production. Use Java 21+ with current Firebase CLI releases.

## Signup and invitations

Everyone signs in with the same email/password form. Owner signup uses business
name, full name, email and password, then continues after verification. Employee
invitations open one email/password form with an existing-account option. A verified
identity accepts only the exact pending invitation, then enters that business.

Expired, revoked, replaced and consumed invitations do not grant access. Workspace
codes and legacy join approvals are retired; managers send invitations instead.
Verification/reset handling stays on the website after configuring the Firebase
Authentication email action URL. Backend initialization preserves existing records,
backs them up privately and requires existing employees to be re-invited.

## Source layout and limits

- `functions/`: callable handlers, server authorization and locked dependencies.
- `secure-backend.js`: browser adapter; no direct Firestore fallback.
- `firestore.rules`: backend-only data; all browser reads/writes denied.
- `FIREBASE_SECURITY_REVIEW.md`: assessment of the user-supplied legacy rules.
- `cloudflare-worker/worker-v147.mjs`: retained legacy email source, unused by the
  new secure client. Mail now uses a server-side Brevo secret and plain-text email.

This remains a draft until the production deployment and disposable-account checks
are completed. Visual browser QA was unavailable because Chromium download failed.
The existing shared storage is private but still subject to Firestore document
size/contention limits. The backend refuses writes near its size limit. Employee
time records require manager review and are not trusted payroll evidence.

The earlier missing extension assets for automation, multiple businesses, business
management and email security have not been reconstructed. The base app and a
secure workplace chooser are included; extension-specific features remain absent.
