'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
const fixtures={
 'functions/.env.local':'BOOTSTRAP_OWNER_UID=bootstrap-owner\nMAIL_FROM_EMAIL=sender@example.com\n',
 'functions/.secret.local':'BREVO_API_KEY=emulator-only\n'
};
for(const file of Object.keys(fixtures))if(fs.existsSync(file))throw Error('Refusing to overwrite '+file+'. Move your local configuration aside before running this disposable-project test.');
const direct=process.argv.includes('--direct');
try{
 for(const [file,contents]of Object.entries(fixtures))fs.writeFileSync(file,contents,{flag:'wx',mode:0o600});
 const services=direct?'auth,firestore':'auth,firestore,functions';
 execSync('npx --yes firebase-tools@14.27.0 emulators:exec --project demo-myschedule --only '+services+' "node --test tests/functions.integration.cjs tests/firestore-rules.integration.cjs"',{stdio:'inherit',env:{...process.env,...(direct?{MYSCHEDULE_DIRECT_HANDLERS:'1',BOOTSTRAP_OWNER_UID:'bootstrap-owner',MAIL_FROM_EMAIL:'sender@example.com'}:{})}});
}finally{for(const file of Object.keys(fixtures))fs.rmSync(file,{force:true});}
