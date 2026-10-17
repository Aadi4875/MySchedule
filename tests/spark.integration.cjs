'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
const firebase=require('firebase/compat/app').default;require('firebase/compat/firestore');
const {webcrypto}=require('node:crypto');
const Store=require('../spark-store.js');
const host=process.env.FIRESTORE_EMULATOR_HOST||'';
if(!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host))throw Error('A loopback Firestore emulator is required.');
let env;
before(async()=>{const [hostname,port]=host.split(':');env=await initializeTestEnvironment({projectId:'demo-myschedule',firestore:{host:hostname,port:Number(port),rules:fs.readFileSync('firestore.rules','utf8').replaceAll('REPLACE_WITH_YOUR_OWNER_FIREBASE_UID','owner-a')}});});
after(async()=>{await env?.cleanup();});
function actor(uid,email=uid+'@example.com',verified=true){const db=env.authenticatedContext(uid,{email,email_verified:verified}).firestore();return {uid,email,db,store:Store.create({db,user:()=>({uid,email,emailVerified:verified}),FieldValue:firebase.firestore.FieldValue,Timestamp:firebase.firestore.Timestamp,crypto:webcrypto})};}
async function owner(uid='owner-a'){const a=actor(uid);const created=await a.store.call('createWorkspace',{name:'Owner '+uid,businessName:'Business '+uid});a.businessId=created.businessId;a.profileId=created.userId;await a.store.call('loadWorkspaceState');return a;}
async function employee(a,uid='employee'){const result=await a.store.call('createInvitation',{name:'Member '+uid,email:uid+'@example.com',role:'employee'});const e=actor(uid);const accepted=await e.store.call('acceptInvitation',{token:result.token});e.businessId=accepted.businessId;e.profileId=accepted.userId;return {employee:e,invite:result};}
test('owner signup, exact-email invitation, acceptance and one-time use work under actual rules',async()=>{
 await env.clearFirestore();const a=await owner();const created=await a.store.call('createInvitation',{name:'Invited Member',email:'employee@example.com',role:'employee'});
 const anonymous=Store.create({db:env.unauthenticatedContext().firestore(),user:()=>null,FieldValue:firebase.firestore.FieldValue,Timestamp:firebase.firestore.Timestamp,crypto:webcrypto});
 const summary=await anonymous.call('getInvitation',{token:created.token});assert.equal(summary.businessName,'Business owner-a');assert.equal(summary.email,undefined);
 const wrong=actor('wrong');await assert.rejects(wrong.store.call('acceptInvitation',{token:created.token}));
 const e=actor('employee');const accepted=await e.store.call('acceptInvitation',{token:created.token});assert.equal(accepted.businessId,a.businessId);assert.equal(accepted.state.users.find(p=>p.id===a.profileId).email,'');
 await assert.rejects(e.store.call('acceptInvitation',{token:created.token}));
});
test('cross-business reads, forged owner memberships and forged accepted invitations are denied',async()=>{
 await env.clearFirestore();const a=await owner(),b=await owner('owner-b');const {employee:e,invite}=await employee(a);
 await assertFails(e.db.doc('workplaces/'+b.businessId).get());
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/profiles/'+a.profileId).get());
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/members/'+e.uid).update({role:'owner'}));
 const stranger=actor('stranger');await assertFails(stranger.db.doc('workplaces/'+a.businessId+'/members/stranger').set({uid:'stranger',businessId:a.businessId,profileId:a.profileId,email:stranger.email,role:'owner',status:'active',inviteHash:invite.tokenHash}));
 await assertFails(stranger.db.doc('workplaces/'+a.businessId+'/invitations/'+invite.tokenHash).update({status:'accepted',acceptedByUid:'stranger',acceptedAt:firebase.firestore.FieldValue.serverTimestamp()}));
 await assertFails(e.db.collection('invitePreviews').get());
});
test('unverified users have no business access; standalone membership/profile activation is denied',async()=>{
 await env.clearFirestore();const unverified=actor('unverified','unverified@example.com',false);const created=await unverified.store.call('createWorkspace',{name:'New Owner',businessName:'Unverified Business'});
 await assertFails(unverified.db.doc('workplaces/'+created.businessId).get());
 const a=await owner();const invitation=await a.store.call('createInvitation',{name:'New Member',email:'new@example.com'});const e=actor('new');
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/profiles/'+invitation.userId).update({authUid:'new',status:'active',emailVerified:true,activeInvitationId:''}));
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/members/new').set({uid:'new',businessId:a.businessId,profileId:invitation.userId,email:e.email,role:'employee',status:'active',inviteHash:invitation.tokenHash}));
});
test('replaced, revoked, expired and wrong-UID invitations cannot activate access',async()=>{
 await env.clearFirestore();const a=await owner();const old=await a.store.call('createInvitation',{name:'New Member',email:'new@example.com'});const next=await a.store.call('createInvitation',{name:'New Member',email:'new@example.com'});const e=actor('new');
 await assert.rejects(e.store.call('acceptInvitation',{token:old.token}));await a.store.call('revokeInvitation',{invitationId:next.tokenHash});assert.equal((await e.store.call('getInvitation',{token:next.token})).status,'revoked');await assert.rejects(e.store.call('acceptInvitation',{token:next.token}));
 const expired=await a.store.call('createInvitation',{name:'New Member',email:'new@example.com'});await env.withSecurityRulesDisabled(async context=>{await context.firestore().doc('workplaces/'+a.businessId+'/invitations/'+expired.tokenHash).update({expiresAt:firebase.firestore.Timestamp.fromMillis(1)});});await assert.rejects(e.store.call('acceptInvitation',{token:expired.token}));
});
test('employee pending clock records and requests can be saved, but approvals and role changes cannot',async()=>{
 await env.clearFirestore();const a=await owner(),{employee:e}=await employee(a);const loaded=await e.store.call('loadWorkspaceState');
 loaded.state.timesheets.push({id:'time',businessId:a.businessId,employeeId:e.profileId,shiftId:'',scheduledStart:'',scheduledEnd:'',role:'employee',clockIn:new Date().toISOString(),clockOut:null,breaks:[],status:'open',managerNote:'',isException:true,exceptionReason:'Cover',exceptionNote:'Test',exceptionCreatedAt:new Date().toISOString()});
 loaded.state.requests.push({id:'request',businessId:a.businessId,employeeId:e.profileId,status:'pending',message:'Please change my shift'});
 const saved=await e.store.call('saveWorkspaceState',{state:loaded.state,expectedRevision:loaded.revision});assert.equal(saved.ok,true);
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/timesheets/time').update({status:'approved'}));await assertFails(e.db.doc('workplaces/'+a.businessId+'/requests/request').update({status:'approved'}));
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/profiles/'+e.profileId).update({role:'owner'}));
});
test('removal immediately blocks data; manager invitations require owner authority',async()=>{
 await env.clearFirestore();const a=await owner();const invited=await a.store.call('createInvitation',{name:'Manager',email:'manager@example.com',role:'manager'});const m=actor('manager');await m.store.call('acceptInvitation',{token:invited.token});
 await assert.rejects(m.store.call('createInvitation',{name:'Another Manager',email:'another@example.com',role:'manager'}));
 const {employee:e}=await employee(a);await a.store.call('removeMember',{userId:e.profileId});await assert.rejects(e.store.call('loadWorkspaceState'));
 await assertFails(e.db.doc('workplaces/'+a.businessId+'/shifts/any').get());
});
test('one account invited to two businesses enters the invited business and lists only its memberships',async()=>{
 await env.clearFirestore();const a=await owner(),b=await owner('owner-b'),{employee:e}=await employee(a);const invite=await b.store.call('createInvitation',{name:'Member',email:e.email});const joined=await e.store.call('acceptInvitation',{token:invite.token});assert.equal(joined.businessId,b.businessId);const list=await e.store.call('listWorkspaces');assert.equal(list.workspaces.length,2);
});
test('legacy state is frozen and readable only by the explicitly pinned migration owner',async()=>{
 await env.clearFirestore();await env.withSecurityRulesDisabled(async context=>{await context.firestore().doc('apps/myschedule_public_launch').set({state:{businesses:[],users:[]}});});
 const a=actor('owner-a'),other=actor('owner-b');assert.ok((await a.db.doc('apps/myschedule_public_launch').get()).exists);await assertFails(other.db.doc('apps/myschedule_public_launch').get());await assertFails(a.db.doc('apps/myschedule_public_launch').update({state:{}}));
});

test('free owner migration preserves the frozen source and records, pauses old memberships and can resume safely',async()=>{
 await env.clearFirestore();const a=actor('owner-a');const legacy={businesses:[{id:'legacy-a',name:'Legacy A',country:'Australia'}],users:[{id:'old-owner',businessId:'legacy-a',name:'Owner',email:a.email,authUid:a.uid,role:'owner',status:'active'},{id:'old-staff',businessId:'legacy-a',name:'Staff',email:'staff@example.com',authUid:'old-staff',role:'employee',status:'active'}],shifts:[{id:'old-shift',businessId:'legacy-a',employeeId:'old-staff',status:'published'}],timesheets:[{id:'old-time',businessId:'legacy-a',employeeId:'old-staff',status:'approved',clockIn:'2026-01-01T00:00:00Z'}]};
 await env.withSecurityRulesDisabled(async context=>{await context.firestore().doc('apps/myschedule_public_launch').set({state:legacy});});
 const preview=await a.store.call('inspectLegacyWorkspaces');assert.equal(preview.workspaces.length,1);await a.store.call('initializeBackend',{businessIds:['legacy-a']});
 const marker=(await a.db.doc('sparkMigrations/legacy-a').get()).data();assert.equal(marker.complete,true);assert.notEqual(marker.businessId,'legacy-a');
 const loaded=await a.store.call('loadWorkspaceState');assert.equal(loaded.state.shifts[0].id,'old-shift');assert.equal(loaded.state.timesheets[0].status,'approved');assert.equal(loaded.state.users.find(p=>p.id==='old-staff').status,'inactive');assert.equal(loaded.state.users.find(p=>p.id==='old-staff').authUid,undefined);
 assert.deepEqual((await a.db.doc('apps/myschedule_public_launch').get()).data().state,legacy);
 await a.store.call('initializeBackend',{businessIds:['legacy-a']});
});

test('a removed employee can accept a new invitation without regaining any other business',async()=>{
 await env.clearFirestore();const a=await owner(),{employee:e}=await employee(a);await a.store.call('removeMember',{userId:e.profileId});const invited=await a.store.call('createInvitation',{name:'Rehired Employee',email:e.email});const joined=await e.store.call('acceptInvitation',{token:invited.token});assert.equal(joined.businessId,a.businessId);assert.equal(joined.role,'employee');
});

test('actual owner/employee screens round-trip through Spark, including employee clocking and in-app manager notifications',async()=>{
 await env.clearFirestore();const a=await owner(),{employee:e}=await employee(a);
 const {JSDOM,VirtualConsole}=require('jsdom');
 for(const person of [a,e]){
  const dom=new JSDOM(fs.readFileSync('index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://aadi4875.github.io/MySchedule/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});const w=dom.window;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});w.fetch=async()=>{throw Error('No external networking');};
  function script(source){const node=w.document.createElement('script');node.textContent=source;w.document.body.appendChild(node);}
  try{
   script(fs.readFileSync('config.js','utf8'));script(fs.readFileSync('invite-core.js','utf8'));
   script(fs.readFileSync('app.js','utf8')+'\nwindow.attachSpark=function(db,user){firebaseDb=db;firebaseReady=true;firebaseAuth={currentUser:user};};window.setSparkState=function(s,p){state=migrateState(s);setCurrentSession(p);};window.sparkSnapshot=()=>state;');
   w.attachSpark(person.db,{uid:person.uid,email:person.email,emailVerified:true});w.firebase={firestore:{FieldValue:firebase.firestore.FieldValue,Timestamp:firebase.firestore.Timestamp}};w.MyScheduleSparkStore=Store;
   script(fs.readFileSync('secure-backend.js','utf8'));await new Promise(resolve=>setTimeout(resolve,30));
   w.setSparkState(await w.loadFirebaseState(),person.profileId);assert.equal(await w.saveFirebaseState(w.sparkSnapshot()),true,w.document.getElementById('toast').textContent);
   if(person===e){
    w.clockIn({emergency:true,reason:'Manager requested cover',note:'Test cover'});await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(await w.saveFirebaseState(w.sparkSnapshot()),true,w.document.getElementById('toast').textContent);
    w.clockOut();await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await w.saveFirebaseState(w.sparkSnapshot()),true,w.document.getElementById('toast').textContent);
    const times=await person.db.collection('workplaces').doc(a.businessId).collection('timesheets').where('employeeId','==',e.profileId).get();assert.equal(times.docs[0].data().status,'pending');
   }
  }finally{w.close();}
 }
 const notes=await a.db.collection('workplaces').doc(a.businessId).collection('notifications').get();assert.ok(notes.docs.some(n=>n.data().createdByUserId===e.profileId));
});
