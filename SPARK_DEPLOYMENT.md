# Free Spark deployment — no billing upgrade

The user explicitly requires a no-spend solution. **Keep Firebase on Spark. Do not
link a billing account, upgrade to Blaze, deploy Functions, or purchase a plan.**
The Functions version has been removed. This version uses Firebase Authentication,
Firestore Security Rules, GitHub Pages and the existing email Worker. Free usage
quotas still apply; exhausting a quota may pause service until reset. A saved
invitation can always be copied/shared without sending email through the app.

These are source changes in a draft PR, not a live deployment. The current live
rules remain the broad legacy rules until you publish the replacement yourself.

## 1. Identify the migration owner

In Firebase Console → Authentication → Users, open your existing owner's account
and copy its **User UID**. This is not the email, app profile ID, password, API key
or invitation token.

In `firestore.rules`, replace:

`REPLACE_WITH_YOUR_OWNER_FIREBASE_UID`

with that exact UID, keeping the surrounding quotes. Only this explicitly pinned,
verified account can read the frozen legacy document for migration. Other owners
and employees cannot read it. New business signup does not use this exception.
Do not replace it with `request.auth != null` or open the database to all users.

## 2. Download and test the source

```sh
git clone --branch codex/simplify-secure-auth https://github.com/Aadi4875/MySchedule.git
cd MySchedule
npm ci
npm run build
npm run lint
npm test
npm run test:emulators
```

If already cloned, fetch and check out the branch rather than cloning over it.
Node/npm are local development tools, not a paid hosting service. Emulator tests
need Java 17+; the helper pins Firebase CLI 14.27.0 and uses only a disposable demo
project on loopback. The Firebase npm packages are test dependencies; they do not
deploy a backend or enable billing.

## 3. Coordinate the rules, website and email Worker

Use a short maintenance window. The old website expects the insecure shared record,
so it cannot keep working after the new rules are published. Do not restore the
old broad permissions to resolve a deployment error.

1. Review the rules and source. Keep the current shared record intact; it will
   become read-only for the pinned owner and serves as the frozen migration source.
2. In Firebase Console → Firestore Database → Rules, publish the reviewed rules
   after replacing the owner UID. Alternatively use:

   ```sh
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules --project myschedule-8f213
   ```

   Confirm the project ID is your existing project before deploying. This command
   deploys **rules only**, not Cloud Functions, and does not change your plan.
3. Publish this PR's matching static files to GitHub Pages through the repository's
   normal publishing process. Keep the `spark-store.js` asset with the other files.
4. If you want automatic invitation email, update the existing Cloudflare Worker
   with `cloudflare-worker/worker-v147.mjs`. Despite its historical filename, this
   is the updated Spark-compatible source. Keep the existing free Worker plan and
   existing Brevo secret/sender settings. Never paste a Brevo key into the website
   or GitHub. The new Worker reads only the selected workplace using the caller's
   Firebase token; it has no service account or ability to bypass Firestore rules.
   You can skip mail setup and copy/share invitation links instead.

There is no `functions/` folder or Functions deployment command in this version.

## 4. Migrate your existing business without deleting history

1. Open `https://aadi4875.github.io/MySchedule/?spark-setup=1`.
2. Enter your existing owner's email and password in the sign-in fields, then click
   **Owner: migrate existing workplace**. Firebase handles those credentials. The
   pinned owner's email must already be verified.
3. Review the business names before confirming. Only legacy owner records matching
   this verified UID/email are selected. If anything is unfamiliar, stop and review
   it rather than granting access.
4. The importer creates a fresh, random workplace ID; it does not overwrite a
   business somebody else created. It preserves profile IDs, shifts, requests and
   timesheets in the new business namespace. The original shared record is never
   modified or deleted. Migration markers allow an interrupted import to resume.
5. Other legacy profiles are imported as inactive with their previous UID binding
   removed. Their old invitations are not copied. This is required because the
   old rules allowed users to edit roles and membership data.
6. Sign in normally. Resend invitations to the exact employee/manager emails. Existing
   Firebase accounts use **Already have an account? Sign in** and keep their own
   password. Existing work records remain associated with the preserved profile ID.
7. Test a disposable employee before ending the maintenance window.

After verifying migration, remove the temporary legacy-read exception by changing
`allow get: if migrationAdmin();` under `/apps/myschedule_public_launch` to
`allow get: if false;`, then republish the rules. Keep the frozen source safely
stored; restoring or deleting it later requires a separate, reviewed decision.
Existing unrelated businesses or orphan records are not guessed into your ownership.

For a brand-new account with no legacy records, use Business signup normally; no
migration or owner-UID exception is needed.

## 5. Keep verification and reset links on the same website

In Firebase → Authentication → Settings → Authorized domains, confirm
`aadi4875.github.io` is allowed. Then Authentication → Templates → Customize action
URL should be:

`https://aadi4875.github.io/MySchedule/`

Publish the new website assets before changing this action URL. It applies to all
Authentication email templates. The website handles verification, password reset,
verified email changes and email recovery. Keep the original signup tab open for
automatic continuation after verification. These are Firebase Authentication
emails, independent of the optional invitation-email Worker.

## Security and release checks

The actual Firestore emulator rules tests cover owner signup, invited-email proof,
one-time atomic acceptance, cross-business read rejection, forged role/membership
rejection, unverified accounts, standalone profile activation, expiry/revocation/
replacement, private employee data, pending timesheets/requests, removal, re-inviting
removed staff, multiple businesses, and resumable frozen-source migration.

Before publishing, also check real browser layout and your actual Firebase/Worker
configuration with a disposable account. Local tests do not prove inbox delivery
or deployed configuration. Chromium visual QA was unavailable in the coding runtime.

Workspace-code self-join is retired. Employees enter only through invitations.
Employee timesheets remain submitted records requiring manager review; they are
not trusted payroll evidence. Rules limit employee writes to their own records
and prevent them from approving requests, promoting themselves or modifying other
businesses. Records shown in the shared directory contain only limited display
fields; private profiles and unpublished shifts have separate access checks.

Rule access-call limits can reject very large atomic saves. The client caps saves
and writes only changed records. Split a large change into smaller saves if needed.
The revision listener avoids repeatedly polling entire workplaces; ordinary free
Firestore read/write quotas still apply. Keep billing disabled to preserve the
no-spend constraint. No automatic upgrade is performed by any project code.

Official references:
- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/docs/firestore/security/rules-conditions
- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/auth/custom-email-handler
