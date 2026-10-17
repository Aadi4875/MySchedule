'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {defineString,defineSecret}=require('firebase-functions/params');
const {initializeApp,getApps}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth}=require('firebase-admin/auth');
const core=require('./core.cjs');
if(!getApps().length)initializeApp();
const db=getFirestore();
const ref=db.doc('apps/myschedule_public_launch');
const bootstrapUID=defineString('BOOTSTRAP_OWNER_UID',{description:'Exact Firebase Authentication UID of the existing owner who may initialize this backend. Never use an email here.'});
const fromEmail=defineString('MAIL_FROM_EMAIL',{description:'Verified Brevo sender email address.'});
const brevoKey=defineSecret('BREVO_API_KEY');
const allowedOrigins=['https://aadi4875.github.io',/^http:\/\/localhost(?::\d+)?$/,/^http:\/\/127\.0\.0\.1(?::\d+)?$/];
function caller(request){return request.auth?{uid:request.auth.uid,email:request.auth.token.email||'',verified:request.auth.token.email_verified===true}:null;}
function reject(code,message){throw new HttpsError(code,message);}
function size(doc){if(Buffer.byteLength(JSON.stringify(doc),'utf8')>930000)reject('resource-exhausted','The shared backend document is near its size limit. Archive resolved history before adding more data.');}
async function bootstrap(request,auth,action){
 core.identity(auth);if(auth.uid!==bootstrapUID.value())reject('permission-denied','Only the configured bootstrap owner can initialize the backend.');
 const currentUser=await getAuth().getUser(auth.uid);
 if(currentUser.disabled||!currentUser.emailVerified||currentUser.email?.toLowerCase()!==auth.email.toLowerCase())reject('permission-denied','The administrator identity must be current and verified.');
 if(action==='inspectLegacyWorkspaces'){
  const snap=await ref.get();const doc=snap.data()||{};
  if(doc.securityVersion===150)return {ok:true,initialized:true};
  const state=core.shape(doc.state||{});
  return {ok:true,workspaces:state.businesses.filter(b=>state.users.some(u=>u.businessId===b.id&&u.role==='owner'&&u.email?.toLowerCase()===auth.email.toLowerCase()&&(!u.authUid||u.authUid===auth.uid))).map(b=>({businessId:b.id,name:b.name,teamCount:state.users.filter(u=>u.businessId===b.id).length}))};
 }
 const selected=request.data?.payload?.businessIds;
 if(!Array.isArray(selected)||selected.length>20||new Set(selected).size!==selected.length)reject('invalid-argument','Select the existing businesses you personally own.');
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref);const original=snap.data()||{};
  if(original.securityVersion===150)reject('already-exists','Backend is already initialized.');
  const state=core.shape(structuredClone(original.state||{}));const bindings=[];
  for(const businessId of selected){
   const owners=state.users.filter(u=>u.businessId===businessId&&u.role==='owner'&&u.email?.toLowerCase()===auth.email.toLowerCase()&&(!u.authUid||u.authUid===auth.uid));
   if(owners.length!==1||!state.businesses.some(b=>b.id===businessId))reject('permission-denied','An owner record does not match the verified administrator.');
   const p=owners[0];bindings.push({uid:auth.uid,email:auth.email.toLowerCase(),businessId,userId:p.id,role:'owner',status:'active',source:'reviewed_migration'});
  }
  if(state.businesses.length&&!bindings.length)reject('failed-precondition','Existing data found. Select your businesses before initializing.');
  for(const p of state.users){
   const trusted=bindings.find(b=>b.businessId===p.businessId&&b.userId===p.id);
   if(trusted){p.authUid=trusted.uid;p.email=trusted.email;p.status='active';p.emailVerified=true;}
   else{p.status='inactive';p.activeInvitationId='';p.emailVerified=false;delete p.authUid;}
   delete p.password;delete p.localPassword;delete p.tempPassword;
  }
  for(const invite of state.accessInvitations)if(invite.status==='pending')invite.status='revoked';
  for(const request of state.joinRequests)if(request.status==='pending'){request.status='rejected';request.decisionNote='Security migration: use a new workplace invitation.';}
  const migrated={state,bindings,securityVersion:150,revision:Number(original.revision||0)+1,updatedAt:new Date().toISOString()};size(migrated);
  // This private, immutable-by-client backup precedes the first access migration.
  if(snap.exists)tx.create(db.doc('migrationBackups/before_v150'),original);
  tx.set(ref,migrated);return {ok:true,businessIds:bindings.map(b=>b.businessId),membersRequireReinvitation:true};
 });
}
exports.scheduleApi=onCall({region:'us-central1',cors:allowedOrigins,maxInstances:5,timeoutSeconds:30,memory:'256MiB'},async request=>{
 const auth=caller(request);const {action,payload={}}=request.data||{};
 try{
  if(auth){const user=await getAuth().getUser(auth.uid);if(user.disabled||user.email?.toLowerCase()!==auth.email.toLowerCase()||Number(request.auth.token.auth_time||0)*1000<Date.parse(user.tokensValidAfterTime||'1970-01-01'))reject('unauthenticated','Your sign-in session changed. Sign in again.');}
  if(['initializeBackend','inspectLegacyWorkspaces'].includes(action))return await bootstrap(request,auth,action);
  if(action==='sendWorkplaceEmail')reject('unimplemented','Use the dedicated email endpoint.');
  return await db.runTransaction(async tx=>{
   const snap=await tx.get(ref);const original=snap.data()||{};
   const {doc,result}=core.run(original,auth,action,payload);
   if(JSON.stringify(doc)!==JSON.stringify(original)){size(doc);tx.set(ref,doc);}
   return result;
  });
 }catch(error){if(error instanceof HttpsError)throw error;const allowed=['unauthenticated','permission-denied','failed-precondition','invalid-argument','not-found','already-exists','aborted','deadline-exceeded','resource-exhausted','unimplemented'];throw new HttpsError(allowed.includes(error.code)?error.code:'internal',allowed.includes(error.code)?error.message:'The secure backend could not complete this operation.');}
});
exports.sendWorkplaceEmail=onCall({region:'us-central1',cors:allowedOrigins,secrets:[brevoKey],maxInstances:3,timeoutSeconds:30,memory:'256MiB'},async request=>{
 try{
  const auth=caller(request),payload=request.data||{};core.identity(auth);
  const authUser=await getAuth().getUser(auth.uid);if(authUser.disabled)reject('permission-denied','This account is disabled.');
  const snap=await ref.get();const authorization=core.run(snap.data()||{},auth,'sendWorkplaceEmail',payload).result;
  // Rate limits are stored privately; a client-supplied request ID is not trusted.
  const rateRef=db.doc('mailLimits/'+core.hash(auth.uid+':'+authorization.businessId));
  await db.runTransaction(async tx=>{const rate=await tx.get(rateRef);const old=rate.data()||{};const windowStart=Date.now()-60000;const count=old.startedAt>windowStart?Number(old.count||0):0;if(count>=20)reject('resource-exhausted','Email limit reached. Wait one minute.');tx.set(rateRef,{count:count+1,startedAt:count?old.startedAt:Date.now()});});
  const subject=String(payload.subject||'MySchedule notification').slice(0,180);
  const message=String(payload.message||'').slice(0,20000);
  // Send plain text. The client cannot inject executable email HTML or sender identity.
  const result=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':brevoKey.value(),'Content-Type':'application/json'},body:JSON.stringify({sender:{name:'MySchedule',email:fromEmail.value()},to:[{email:authorization.to}],replyTo:{email:authorization.replyTo||fromEmail.value()},subject,textContent:message})});
  if(!result.ok)reject('unavailable','Email provider rejected delivery. The invitation remains saved; share its link or retry.');
  const accepted=await result.json();return {ok:true,messageId:accepted.messageId||''};
 }catch(error){if(error instanceof HttpsError)throw error;throw new HttpsError(['permission-denied','unauthenticated','failed-precondition','invalid-argument'].includes(error.code)?error.code:'unavailable',error.code?error.message:'Email was not sent. Retry or share the saved invitation link.');}
});
