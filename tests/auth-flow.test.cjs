const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const {JSDOM}=require('jsdom');
const core=require('../invite-core.js');
const token='a'.repeat(64);
const hash=createHash('sha256').update(token).digest('hex');
const proof=createHash('sha256').update(`${token}|member@example.com`).digest('hex');
function transactionFixture(change=()=>{},authChange={}){
 const remote={businesses:[{id:'invited-business'},{id:'other-business'}],users:[{id:'member',businessId:'invited-business',email:'member@example.com',role:'employee',status:'invited',activeInvitationId:hash},{id:'other',businessId:'other-business',email:'member@example.com',role:'employee',status:'active'}],accessInvitations:[{id:hash,tokenHash:hash,userId:'member',businessId:'invited-business',email:'member@example.com',role:'employee',status:'pending',expiresAt:'2099-01-01'}],notifications:[]};change(remote);
 let writes=0;
 const context={console:{warn(){},error(){}},window:{MyScheduleInviteCore:core},firebaseAuth:{currentUser:{uid:'uid',email:'member@example.com',emailVerified:true,...authChange}},initFirebase:()=>true,FIREBASE_DOC_PATH:'test',migrateState:x=>x,state:{},cloudRevision:0,document:{},setTimeout,Uint8Array,Date,URL};
 context.firebaseDb={collection:()=>({doc:()=>({set:async()=>{}})}),runTransaction:async callback=>callback({get:async()=>({exists:true,data:()=>({state:remote,revision:1})}),set:(_ref,data)=>{writes++;Object.assign(remote,data.state);}})};
 vm.createContext(context);vm.runInContext(fs.readFileSync('invitation-v138.js','utf8'),context);
 return {api:context.window.MyScheduleInvitationV138,remote,writes:()=>writes};
}
test('acceptance consumes only the invited business membership and rejects replay',async()=>{
 const f=transactionFixture();const result=await f.api.acceptInvitationAtomic({token});
 assert.equal(result.businessId,'invited-business');assert.equal(result.userId,'member');assert.equal(f.remote.users[0].authUid,'uid');assert.equal(f.remote.users[1].authUid,undefined);assert.equal(f.writes(),1);
 await assert.rejects(f.api.acceptInvitationAtomic({token}),/no longer pending/);assert.equal(f.writes(),1);
});
test('wrong email, unverified, expired, revoked, replaced and mismatched memberships cannot accept',async()=>{
 const cases=[
  [()=>{},{email:'wrong@example.com'}],[()=>{},{emailVerified:false}],
  [r=>r.accessInvitations[0].expiresAt='2000-01-01',{}],
  [r=>r.accessInvitations[0].status='revoked',{}],
  [r=>r.users[0].activeInvitationId='replacement',{}],
  [r=>r.users[0].businessId='other-business',{}],
  [r=>r.users[0].role='owner',{}],
  [r=>r.users[0].authUid='someone-else',{}]
 ];
 for(const [change,auth] of cases){const f=transactionFixture(change,auth);await assert.rejects(f.api.acceptInvitationAtomic({token}));assert.equal(f.writes(),0);}
});
async function inviteUI(){
 const dom=new JSDOM('<main id="app"></main>',{url:`https://example.com/MySchedule/?invite=${token}&recipient=${proof}`,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;const calls=[];
 w.loginView=()=>'<p>Regular login</p>';w.render=()=>{w.document.getElementById('app').innerHTML=w.loginView();};w.clearCurrentSession=()=>{};
 const user={email:'member@example.com',emailVerified:false,updateProfile:async()=>{},sendEmailVerification:async()=>{calls.push('verify');},reload:async()=>{}};
 const auth={currentUser:null,setPersistence:async()=>{},createUserWithEmailAndPassword:async(email)=>{calls.push(email);auth.currentUser=user;return {user};},signOut:async()=>{auth.currentUser=null;}};
 w.firebaseAuth=auth;w.firebase={auth:Object.assign(()=>auth,{Auth:{Persistence:{LOCAL:'local',SESSION:'session'}}})};
 w.MyScheduleInvitationV138={hashToken:async value=>createHash('sha256').update(value).digest('hex'),getInvitation:async()=>({status:'pending',businessName:'Invited business',role:'employee'}),resolveBaseUrl:()=>w.location.href};
 w.eval(fs.readFileSync('invitation-setup-v138.js','utf8'));w.render();await new Promise(r=>setTimeout(r,30));
 return {dom,w,calls,auth};
}
test('invitation opens one form; wrong email makes no account request; correct email goes straight to verification',async()=>{
 const {dom,w,calls}=await inviteUI();
 try{
  assert.match(w.document.querySelector('h1').textContent,/Invited business/);
  assert.equal(w.document.querySelectorAll('#v138SetupBody input').length,2);
  w.document.getElementById('v138InviteEmail').value='wrong@example.com';w.document.getElementById('v138AccountPassword').value='TestPassword123!';
  await w.v138SubmitInvite();assert.deepEqual(calls,[]);assert.match(w.document.getElementById('v138InlineMessage').textContent,/received/);
  w.document.getElementById('v138InviteEmail').value='member@example.com';await w.v138SubmitInvite();
  assert.deepEqual(calls,['member@example.com','verify']);assert.ok(w.document.querySelector('.v138-verify-panel'));
 }finally{dom.window.close();}
});
test('verification email failure preserves the created account and exposes resend',async()=>{
 const {dom,w,auth}=await inviteUI();
 try{
  const create=auth.createUserWithEmailAndPassword;auth.createUserWithEmailAndPassword=async(...args)=>{const result=await create(...args);result.user.sendEmailVerification=async()=>{throw Error('Offline');};return result;};
  w.document.getElementById('v138InviteEmail').value='member@example.com';w.document.getElementById('v138AccountPassword').value='TestPassword123!';await w.v138SubmitInvite();
  assert.ok(auth.currentUser);assert.ok(w.document.querySelector('.v138-verify-panel'));assert.match(w.document.getElementById('v138InlineMessage').textContent,/account was created/);
 }finally{dom.window.close();}
});

test('same-site verification handles the code, refreshes identity and restores only trusted invitation context',async()=>{
 for(const origin of ['https://example.com','https://untrusted.example']){
  const continuation=`${origin}/MySchedule/?invite=${token}&recipient=${proof}`;
  const dom=new JSDOM('<main id="app"></main>',{url:`https://example.com/MySchedule/?mode=verifyEmail&oobCode=one-time&continueUrl=${encodeURIComponent(continuation)}`,runScripts:'outside-only'});
  const w=dom.window;const calls=[];w.requireAuth=()=>({applyActionCode:async c=>calls.push(c),currentUser:{reload:async()=>calls.push('reload'),getIdToken:async force=>calls.push(force)}});w.toast=()=>{};
  try{
   w.eval(fs.readFileSync('auth-simple.js','utf8'));await new Promise(r=>setTimeout(r,20));
   assert.deepEqual(calls,['one-time','reload',true]);assert.equal(w.location.search,'');
   assert.equal(w.sessionStorage.getItem('myschedule_v133_invite_token'),origin==='https://example.com'?token:null);
   assert.equal(w.location.origin,'https://example.com');
  }finally{w.close();}
 }
});

test('owner verification saves activation before entering and does not activate invited employees',async()=>{
 for(const role of ['owner','employee']){
  const dom=new JSDOM('<aside class="landing-auth-card"></aside>',{url:'https://example.com/MySchedule/',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;const calls=[];
  const user={uid:'uid',email:'owner@example.com',emailVerified:true,reload:async()=>{},getIdToken:async()=>{}};
  w.requireAuth=()=>({currentUser:user});w.normalizeEmail=x=>x.toLowerCase();w.migrateState=x=>x;
  w.loadFirebaseState=async()=>({users:[{id:'profile',businessId:'business',authUid:'uid',email:user.email,role,status:'pending_verification',accountSource:'workspace_creator'}]});
  w.saveFirebaseState=async()=>{calls.push('saved');return true;};w.finishAuthLogin=async(_user,membership)=>calls.push(membership.businessId);w.startFirebaseLiveUpdates=()=>{};
  try{w.eval(fs.readFileSync('auth-simple.js','utf8'));w.showOwnerVerification();await w.checkOwnerVerification(true);assert.deepEqual(calls,role==='owner'?['saved','business']:[]);}
  finally{w.close();}
 }
});

test('password reset action verifies the code before accepting a strong new password',async()=>{
 const dom=new JSDOM('<main id="app"></main>',{url:'https://example.com/MySchedule/?mode=resetPassword&oobCode=reset-code',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;const calls=[];
 w.requireAuth=()=>({verifyPasswordResetCode:async code=>{calls.push(code);return 'member@example.com';},confirmPasswordReset:async(code,password)=>calls.push([code,password])});
 w.MyScheduleInvitationSetupV138={passwordStatus:password=>({valid:password==='StrongPass123!'})};w.render=()=>{};w.toast=()=>{};
 try{
  w.eval(fs.readFileSync('auth-simple.js','utf8'));await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(calls,['reset-code']);assert.equal(w.location.search,'');
  const form=w.document.querySelector('#auth-reset-form');const input=form.querySelector('input');
  input.value='weak';await form.onsubmit({preventDefault(){}});assert.equal(calls.length,1);
  input.value='StrongPass123!';await form.onsubmit({preventDefault(){}});assert.deepEqual(calls[1],['reset-code','StrongPass123!']);assert.equal(w.document.querySelector('dialog'),null);
 }finally{w.close();}
});

test('cached workspace identity needs a verified matching Firebase identity',()=>{
 const source=fs.readFileSync('app.js','utf8');const start=source.indexOf('function currentUser(){',source.indexOf('/* v104:'));const end=source.indexOf('\nfunction v104OpenView',start);
 const context={state:{users:[{id:'cached',status:'active',authUid:'uid',email:'member@example.com'}]},firebaseAuth:{currentUser:null},currentUserId:'cached',sessionStorage:{getItem:()=>null},localStorage:{getItem:()=>null},normalizeEmail:x=>x.toLowerCase()};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 assert.equal(context.currentUser(),null);
 for(const user of [{uid:'other',email:'member@example.com',emailVerified:true},{uid:'uid',email:'member@example.com',emailVerified:false}]){context.firebaseAuth.currentUser=user;assert.equal(context.currentUser(),null);}
 context.firebaseAuth.currentUser={uid:'uid',email:'member@example.com',emailVerified:true};assert.equal(context.currentUser().id,'cached');
 context.state.users[0].status='invited';assert.equal(context.currentUser(),null);
});
