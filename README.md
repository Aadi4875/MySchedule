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
