/* Integration test: real Auth, Firestore and Functions emulators only. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])if(!/^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env[key]||''))throw Error('Loopback emulators required: '+key);
const functionRequire=require('node:module').createRequire(require('node:path').resolve('functions/package.json'));
const {initializeApp}=functionRequire('firebase-admin/app');
const {getAuth}=functionRequire('firebase-admin/auth');
const {getFirestore}=functionRequire('firebase-admin/firestore');
initializeApp({projectId:'demo-myschedule'});const db=getFirestore();const auth=getAuth();
async function account(uid,email,verified=true){await auth.createUser({uid,email,password:'EmulatorPass123!',emailVerified:verified});const response=await fetch('http://'+process.env.FIREBASE_AUTH_EMULATOR_HOST+'/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'EmulatorPass123!',returnSecureToken:true})});const result=await response.json();assert.ok(result.idToken,result.error?.message);return result.idToken;}
async function call(token,action,payload={}){
 const authContext=token?await auth.verifyIdToken(token):null;
 const request={data:{action,payload},auth:authContext?{uid:authContext.uid,token:authContext}:undefined};
 if(process.env.MYSCHEDULE_DIRECT_HANDLERS==='1'){return require('../functions/index.cjs').scheduleApi.run(request);}
 const response=await fetch('http://127.0.0.1:5001/demo-myschedule/us-central1/scheduleApi',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({data:request.data})});const body=await response.json();if(body.error){const e=Error(body.error.message);e.status=body.error.status;throw e;}return body.result;}
test('first deployment migrates privately and real callable endpoints isolate invited employees',async()=>{
 const owner=await account('bootstrap-owner','bootstrap@example.com');const stranger=await account('stranger','stranger@example.com');
 await db.doc('apps/myschedule_public_launch').set({state:{businesses:[{id:'a',name:'Business A'}],users:[{id:'owner-profile',businessId:'a',authUid:'bootstrap-owner',email:'bootstrap@example.com',name:'Owner',role:'owner',status:'active'},{id:'old-member',businessId:'a',authUid:'old-member',email:'member@example.com',name:'Member',role:'employee',status:'active'}],shifts:[{id:'shift',businessId:'a',employeeId:'old-member',status:'published'}]},revision:1});
 await assert.rejects(call(stranger,'initializeBackend',{businessIds:['a']}));
 const preview=await call(owner,'inspectLegacyWorkspaces');assert.equal(preview.workspaces[0].name,'Business A');
 const initialized=await call(owner,'initializeBackend',{businessIds:['a']});assert.equal(initialized.membersRequireReinvitation,true);
 assert.ok((await db.doc('migrationBackups/before_v150').get()).exists);
 const after=(await db.doc('apps/myschedule_public_launch').get()).data();assert.equal(after.bindings.length,1);assert.equal(after.state.users.find(u=>u.id==='old-member').status,'inactive');assert.equal(after.state.shifts.length,1);
 await assert.rejects(call(owner,'initializeBackend',{businessIds:['a']}));
 const invite=await call(owner,'createInvitation',{businessId:'a',name:'Member',email:'member@example.com',role:'employee'});
 const summary=await call(null,'getInvitation',{token:invite.token});assert.equal(summary.businessName,'Business A');assert.equal(summary.state,undefined);
 const member=await account('member','member@example.com');
 await assert.rejects(call(stranger,'acceptInvitation',{token:invite.token}));
 const accepted=await call(member,'acceptInvitation',{token:invite.token});assert.equal(accepted.businessId,'a');assert.equal(accepted.userId,'old-member');
 await assert.rejects(call(member,'acceptInvitation',{token:invite.token}));
 const otherOwner=await account('other-owner','other-owner@example.com');
 const other=await call(otherOwner,'createWorkspace',{name:'Other Owner',businessName:'Business B'});await call(otherOwner,'loadWorkspaceState',{businessId:other.businessId});
 await assert.rejects(call(member,'loadWorkspaceState',{businessId:other.businessId}));
 const loaded=await call(member,'loadWorkspaceState',{businessId:'a'});assert.equal(loaded.state.businesses.length,1);assert.equal(loaded.state.users.find(u=>u.id==='owner-profile').email,'');
 loaded.state.users.find(u=>u.id==='old-member').role='owner';
 await assert.rejects(call(member,'saveWorkspaceState',{businessId:'a',expectedRevision:loaded.revision,state:loaded.state}));
 await call(owner,'removeMember',{businessId:'a',userId:'old-member'});await assert.rejects(call(member,'loadWorkspaceState',{businessId:'a'}));
});
