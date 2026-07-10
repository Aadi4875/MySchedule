# MySchedule v146

## What was fixed

The published GitHub Pages website no longer sends report email through the Firebase `sendTransactionalEmail` callable that was returning `Internal`.

The new route is:

`GitHub Pages -> Firebase ID token -> Cloudflare Worker -> Brevo`

The Worker:

- permits the published GitHub origin;
- verifies the Firebase ID-token signature and verified email;
- loads the selected MySchedule business;
- checks owner/manager/employee permissions;
- restricts recipients to the selected business;
- sends structured HTML through Brevo;
- returns clear errors instead of `Internal` or raw `Failed to fetch`;
- optionally prevents duplicate sends using the `EMAIL_REQUESTS` KV binding.

The same gateway is now used by manual reports, invitations, reminders, notifications and test email.

## Required rollout

### A. Update the existing Cloudflare Worker once

See `cloudflare-worker/README.md`. Use the supplied `worker-v146.js` while keeping the existing Worker URL.

Required Worker configuration:

- secret `BREVO_API_KEY`;
- variable `FROM_EMAIL` containing a sender verified by Brevo;
- variable `FROM_NAME=MySchedule`;
- variable `FIREBASE_PROJECT_ID=myschedule-8f213`;
- variable `ALLOWED_ORIGINS=https://aadi4875.github.io`.

### B. Upload the GitHub website

Replace every file using `UPLOAD_TO_GITHUB`. Remove the old `security-email-v144.js` file from the repository.

### C. Optional Firebase deployment

Email from the open GitHub website does not need the Firebase email callable. Firebase Functions remain necessary for owner OTP business creation/deletion and closed-browser scheduled automation. Deploy those once with the v146 owner OTP script.

## Production test

After GitHub and Worker deployment:

1. Sign out and sign in again.
2. Send `Settings -> Email Notifications -> Send Test to My Email`.
3. Send a report from the Report Delivery Centre.
4. Create one test invitation.
5. Confirm all three messages arrive and show a sent status in MySchedule.


## v146 sender configuration repair
The Worker now accepts a plain sender email and safely normalises common Cloudflare dashboard mistakes such as quoted values, `FROM_EMAIL = address`, or `MySchedule <address>`. The health endpoint shows only a masked sender and configuration booleans. Deploy `cloudflare-worker/worker-v146.js`, then open the Worker URL and confirm `version: 146.0.0`, `brevoKeyConfigured: true`, and `fromEmailValid: true`.
