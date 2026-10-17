'use strict';
const path=require('node:path');const {execSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
// Demo project + loopback-only tests; no Cloud Functions and no credentials.
execSync('npx --yes firebase-tools@14.27.0 emulators:exec --project demo-myschedule --only firestore "node --test tests/spark.integration.cjs"',{stdio:'inherit'});
