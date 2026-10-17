# First Firebase deployment

This branch adds the backend that was missing from this project. It is not deployed
by creating or merging the GitHub PR. The Firebase console's **Waiting for your
first deploy** screen confirms that Functions have not been deployed there.

## What changes

- The browser signs in through Firebase Authentication, but all workplace data and
  invitation operations go through `scheduleApi` in `us-central1`.
- Firestore rules deny all direct browser reads and writes. The Admin SDK backend
  privately retains the existing document and returns only the selected business.
- An independent, server-only membership registry controls business, role and UID;
  browser-edited profile fields never grant access.
- New invitations expire after seven days, are one-time, and require the invited
  email to be verified by Firebase. Resend revokes the old token.
- Existing records are preserved and privately backed up during initialization.
  Only the reviewed bootstrap owner's businesses are activated. Other members
  become inactive and need fresh invitations. Their shifts and time records remain.
- Email uses a new server endpoint and a server-side Brevo secret. The old
  Cloudflare Worker cannot read the private state with browser credentials after
  cutover and is not used by this client. Invitation email is plain text and has a
  directly clickable setup URL. Firebase still sends verification/reset messages.

## Before starting

Use a maintenance window. Existing browser clients will stop working once the
new rules are deployed, until the matching client is published. Do not deploy the
rules alone during normal operation.

You need:

1. The Firebase project `myschedule-8f213`, with the same web app configuration as
   the current site. Verify this project ID in your console before deploying.
2. Node.js 22, npm and Git on your computer.
3. Firebase **Blaze** billing enabled to deploy Cloud Functions. Enabling billing
   is your decision. Free allowances are not a guarantee of zero charges; configure
   billing budget alerts. No billing settings have been changed by this PR.
4. Your existing owner's **Firebase Authentication UID** from Authentication →
   Users. Copy the UID, not the email and not an ID from an application profile.
5. A verified Brevo sender email and the Brevo API key, entered on your own machine.
   Do not put that key in `config.js`, GitHub, this chat or frontend files.
6. A review of the business names/owners and a Firestore export or administrator
   backup of the current data before the maintenance window. Initialization also
   saves the original document in `migrationBackups/before_v150` before migration.
   The backup includes the original sensitive state and is backend-only.

## Download and verify the source

Run from a terminal on your own computer:

```sh
git clone --branch codex/simplify-secure-auth https://github.com/Aadi4875/MySchedule.git
cd MySchedule
npm ci
npm ci --prefix functions
npm test
npm run lint
npm run build
```

If already cloned, fetch and check out the branch instead of cloning over it.

Full emulator verification needs Java 17+ (the test helper pins Firebase CLI 14.27.0):

```sh
npm run test:emulators
```

If the Functions emulator cannot create its local socket, use
`npm run test:emulators -- --direct`. This executes the actual handlers against the
Auth and Firestore emulators, but does not test the Functions HTTP wrapper or CORS.

The helper temporarily writes fake local parameter/secret values, refuses to overwrite
existing local configuration, and removes its fixtures afterward. The tests use only
loopback emulators for the demo project; they do not touch production.

## Deploy the backend and rules together during maintenance

```sh
npx firebase-tools login
npx firebase-tools functions:secrets:set BREVO_API_KEY --project myschedule-8f213
npx firebase-tools deploy --only functions,firestore:rules --project myschedule-8f213
```

Enter the Brevo key only at the secret prompt. Deployment prompts for:

- `BOOTSTRAP_OWNER_UID`: your exact existing Firebase Authentication UID.
- `MAIL_FROM_EMAIL`: the verified Brevo sender address.

These are Firebase parameter values. The CLI may save nonsecret parameters in
`functions/.env.myschedule-8f213`; environment files are ignored by Git. Do not
commit any generated environment file. The Brevo key uses Secret Manager.

Check Functions in the console. It should list `scheduleApi` and
`sendWorkplaceEmail` after deployment. No old functions need removal because the
project currently has none. Deployment can require permission to enable Google
Cloud APIs and configure function invocation; follow the CLI errors instead of
weakening database rules.

## Publish the matching client, then initialize access

1. Publish the reviewed PR's static files to GitHub Pages through the repository's
   normal main-branch publishing process. Do this in the same maintenance window.
2. Open `https://aadi4875.github.io/MySchedule/?backend-setup=1`.
3. Enter your existing owner's email and password in the sign-in fields. Click
   **Administrator: initialize secure backend**. This signs in through Firebase;
   the backend accepts only the exact configured bootstrap UID with verified email.
4. Review the displayed existing business names before confirming. Only businesses
   with an owner record matching your verified UID/email are selected. Other
   businesses are retained but remain inaccessible pending a separate owner audit.
5. Confirm initialization. A private backup is written atomically before the access
   migration. Initialization cannot be run again to reset an initialized registry.
6. Sign in normally. In Team Access, resend each employee/manager's invitation.
   Old invitation links and old pending join requests are intentionally invalidated.
7. Test a new invitation with a disposable second account before ending maintenance.

For an entirely empty project, initialize it first with the configured administrator
account, then use Business signup. If the existing owner record does not match,
stop and correct the reviewed migration mapping through an administrator process;
do not make arbitrary authenticated users owners or re-enable public state access.

## Keep verification/reset on the website

In Firebase Console → Authentication → Settings → Authorized domains, confirm
`aadi4875.github.io` is allowed. In Authentication → Templates → Customize action
URL, set:

`https://aadi4875.github.io/MySchedule/`

Set this only after deploying the new static assets. The handler supports
`verifyEmail`, `resetPassword`, `verifyAndChangeEmail` and `recoverEmail`. This
setting applies to all Authentication email templates. Keep the signup tab open
for automatic continuation after verification, including verification on a second
device. Password reset ends at sign-in; it does not silently authenticate a user.

## Acceptance checks before ending maintenance

- Owner signup/verification and existing owner login succeed.
- New and existing employees join only through their invited, verified email.
- The invited business opens even if that account already has another workplace.
- Wrong-account, expired, revoked, replaced and reused links are denied.
- An employee cannot read business B or change account roles/identity through the API.
- Direct Firestore reads/writes fail for signed-in owners and employees.
- Acknowledgements, requests, clock records and owner roster saves work.
- Concurrent stale saves are rejected with a reload message, not silently applied.
- Removing a member immediately denies future backend reads for that membership.
- Verification, reset and invitation email reach the test inbox; email failure leaves
  a saved invitation that can be shared manually.

## Limits and recovery

This is a first backend implementation and remains a draft pending live-project
integration checks. Auth/Firestore/Functions emulator checks and unit/DOM checks
are included and must pass before release. In the coding environment, Auth and
Firestore emulator tests and direct server-handler integration passed. The complete
Functions HTTP emulator was blocked by an operating-system socket restriction;
that HTTP/CORS check remains required on your computer or in CI. The coding runtime
uses Node 24 locally; deployed functions are configured for Node 22. Unit/DOM tests do not prove inbox delivery or
production IAM configuration. Browser visual QA was unavailable in the coding
runtime because Chromium download failed.

The shared storage document is now server-only, but still has Firestore's document
size and contention limits. The backend stops writes at 930,000 serialized bytes.
Sharding into per-business documents is a future scaling task. Employee time entries
are submitted records requiring managerial review, not trusted payroll evidence.
Workspace-code self-join and legacy join approvals are intentionally unavailable;
use authenticated invitations. Employee emails are replaced by in-app request
notifications; management sends authorized workplace emails through the new endpoint.

Do not restore the old broad rules to resolve an error. Leave maintenance in place,
keep the private backup, fix the failed backend/client/configuration step and retry.
A rollback of data or access bindings must be reviewed by an administrator and
must not overwrite newer records accidentally.

Official references:
- https://firebase.google.com/docs/functions/get-started
- https://firebase.google.com/docs/functions/callable
- https://firebase.google.com/docs/functions/config-env
- https://firebase.google.com/docs/auth/custom-email-handler
