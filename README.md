# MySchedule

Static workforce scheduling frontend: HTML, CSS and vanilla JavaScript. Firebase
10.12.5 browser SDKs provide Authentication, Firestore and callable Functions.
Email uses a Cloudflare Worker/Brevo integration. No React or application server
is included. Node.js is used only for local tooling.

## Run locally

Use Node.js 22 or newer:

```sh
npm ci
npm start
```

Open http://localhost:8000. To use another port on macOS/Linux:
`PORT=8080 npm start`. The local server binds to loopback and serves only the
validated `dist` directory. GitHub Pages can still serve the root static files.

## Configuration

`config.js` contains optional public browser settings for Firebase, the email
Worker URL, and Google Places. Existing built-in Firebase and Worker settings
remain the defaults. A Firebase configuration previously saved in browser storage
takes precedence. Authorize localhost in your Firebase Authentication project
before testing real sign-in. The email Worker must allow your local origin.

`.env.example` documents server-side deployment variables; the browser does not
read `.env`. Never place Brevo keys or other server credentials in `config.js`.
The Google Places key is optional and should be restricted by origin and API.

## Checks

```sh
npm run lint
npm test
npm run build
```

Build checks JavaScript syntax and every local HTML asset reference before copying
assets to `dist`. ESLint checks a focused set of correctness rules; it is not a
comprehensive security audit. Node tests cover invitation validation and isolation,
plus jsdom startup and route rendering for owner, manager and employee fixtures.
DOM tests disable networking and do not verify real authentication or persistence.

## Repository gaps and verification limits

The original HTML referenced eight absent extension assets for automation,
multiple businesses, business management and email security. Those references
were removed to eliminate guaranteed 404s; the missing extensions were not
reconstructed. Corresponding extension-specific functionality remains unavailable.
The supplied app and invitation modules still provide the existing base screens.

The original README also referenced `cloudflare-worker/worker-v146.js`, Firebase
Functions, rules, indexes and upload bundles. None are present in this checkout
(the repository has one initial upload commit). Backend deployment cannot be
reproduced from this repository. Obtain those original sources before claiming
end-to-end production readiness. Do not weaken Firestore rules to work around
missing services.

Real sign-in, database authorization/persistence, report/invitation email, owner
OTP flows and scheduled automation require the corresponding configured services
and separate integration testing. No live business records or emails were changed
during local verification. Chromium installation failed in the execution
environment, so visual browser QA has not been completed.

## Repairs

- Scoped invitation replacement to the selected business: the same email in a
  different business no longer has its pending invitation revoked.
- Removed missing static asset references and replaced misleading setup steps.
- Added startup failure handling with a retry screen.
- Added public configuration hooks, a server environment reference, reproducible
  dependency lockfile, local server, build checks, linting and regression tests.

## Email request contract repair

The supplied Worker source is now preserved at
`cloudflare-worker/worker-v147.mjs` (unchanged from the uploaded `.js` file).
This supersedes the earlier note that no Worker source is available; Firebase
backend sources remain absent. Adding this file does not deploy it to Cloudflare.
Browser mail requests now include `action: "send-email"`, a unique `requestId`,
`businessId`, `templateType`, `toName`, and a Firebase bearer token.
A contract test executes this Worker using a locally signed test token and mocked
Firebase/Brevo responses. It verifies request compatibility, not inbox delivery.

## Simplified authentication (v149)

- One email/password sign-in for owners and employees; Enter submits the form.
- Owner signup asks only business name, full name, email and password. Keep the
  signup tab open: after email verification, it saves activation and enters the
  workspace without asking for the password again.
- Employee invitations open one email/password form. Existing users choose
  **Already have an account? Sign in**. There is no workplace code, repeated
  password or extra manager approval. A verified existing account joins directly.
- Verification is checked on focus and every five seconds while the setup page
  is visible. Delivery failures preserve the account and provide a resend button.
- Acceptance consumes the current invitation atomically, checks expiry, verified
  email, profile UID, role, business and replacement token, then opens that exact
  membership. Legacy acceptance/repair/join paths cannot activate an invitation.
- Browser membership restoration now requires a matching verified Firebase
  identity and active membership. Passwords are passed unchanged to Firebase.

### Required Firebase configuration for same-site email links

After deploying these assets, in **Firebase Console → Authentication → Templates
→ Customize action URL**, set:

`https://aadi4875.github.io/MySchedule/`

In **Authentication → Settings → Authorized domains**, confirm
`aadi4875.github.io` is allowed. Do not change the Firebase authDomain to a GitHub
Pages domain. The public Firebase config is not an admin credential.

The action URL applies to all email templates. `auth-simple.js` handles email
verification, verification before email changes, email recovery and password
reset on the same site. Invitation context is recovered only from a same-origin,
same-path continue URL; the app never navigates to an arbitrary continue URL.
See [Firebase custom email handlers](https://firebase.google.com/docs/auth/custom-email-handler).
Until this console change is made, Firebase's hosted email confirmation page
will still appear; keeping the original setup tab open lets it continue after
verification. Old invitations without a recipient proof need to be resent.

### Security and release verification

These are frontend checks, not a replacement for server authorization. This
repository still stores shared workplace state in `apps/{document}` and performs
client-side transactions. The deployed Firestore rules and Firebase Functions
are absent. It is not possible to assert tenant isolation against a modified
client without inspecting and testing the deployed backend. Never grant broad
read/write permission to the shared state document to make signup work. The
server must enforce the verified email/UID, invitation token, expiry, revocation,
one-time consumption and business membership independently of this JavaScript.
Public invitation summaries must be read-only for recipients and writable only
by the inviting business's authorized managers.

Before release, review the deployed rules and test with disposable owner and
employee accounts in two businesses: new signup, verification in the same and
another tab/device, existing account, wrong signed-in account, expired/revoked/
replaced/reused invitation, denied cross-business reads/writes, reset password,
verified email change, and email delivery failure. Automated tests mock Firebase;
they do not verify deployed rules, inbox delivery or live authorization.
