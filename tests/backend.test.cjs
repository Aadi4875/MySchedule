'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {run,shape,scoped}=require('../functions/core.cjs');
const clone=structuredClone;
const now=Date.parse('2026-10-17T00:00:00Z');
const owner={uid:'oa',email:'oa@example.com',verified:true};
const otherOwner={uid:'ob',email:'ob@example.com',verified:true};
const employee={uid:'ea',email:'ea@example.com',verified:true};
const auth={owner,otherOwner,employee};
function fixture(){
 const users=[{id:'oa',businessId:'a',authUid:'oa',email:owner.email,role:'owner',status:'active',name:'Owner A'},{id:'ob',businessId:'b',authUid:'ob',email:otherOwner.email,role:'owner',status:'active',name:'Owner B'},{id:'ea',businessId:'a',authUid:'ea',email:employee.email,role:'employee',status:'active',name:'Employee A'}];
 return {securityVersion:150,revision:1,bindings:users.map(u=>({uid:u.authUid,userId:u.id,businessId:u.businessId,role:u.role,email:u.email,status:'active'})),state:shape({businesses:[{id:'a',name:'A'},{id:'b',name:'B'}],users,shifts:[{id:'sa',businessId:'a',employeeId:'ea',status:'published',date:'2026-10-17'},{id:'draft',businessId:'a',employeeId:'ea',status:'draft'},{id:'sb',businessId:'b',employeeId:'ob',status:'published'}],notifications:[{id:'na',businessId:'a',userId:'oa',message:'Private owner note'},{id:'ne',businessId:'a',userId:'ea',read:false},{id:'nb',businessId:'b',userId:'ob'}],notices:[{id:'owner-notice',businessId:'a',audience:'owner'},{id:'employee-notice',businessId:'a',audience:'employee'}],emailConfig:{secret:'must never leave server'}})};
}
function action(doc,who,name,payload={}){return run(doc,who,name,payload,{now});}
function save(doc,who,snapshot){return action(doc,who,'saveWorkspaceState',{businessId:'a',expectedRevision:doc.revision,state:snapshot});}
test('unauthenticated, unverified and nonmembers cannot load any workplace',()=>{
 for(const caller of [null,{...employee,verified:false},{uid:'stranger',email:'stranger@example.com',verified:true}])assert.throws(()=>action(fixture(),caller,'loadWorkspaceState',{businessId:'a'}));
 assert.throws(()=>action(fixture(),employee,'loadWorkspaceState',{businessId:'b'}),{code:'permission-denied'});
});
test('owner and employee responses contain only the authorized business; employee private data is filtered',()=>{
 const doc=fixture();for(const [caller,id]of [[owner,'a'],[otherOwner,'b'],[employee,'a']]){
  const result=action(doc,caller,'loadWorkspaceState',{businessId:id}).result;
  for(const [key,rows]of Object.entries(result.state))if(Array.isArray(rows))assert.ok(rows.every(r=>key==='businesses'?r.id===id:r.businessId===id),key);
  assert.equal(result.state.emailConfig.secret,undefined);
 }
 const employeeState=action(doc,employee,'loadWorkspaceState',{businessId:'a'}).result.state;
 assert.equal(employeeState.users.find(u=>u.id==='oa').email,'');assert.equal(employeeState.users.find(u=>u.id==='oa').authUid,undefined);
 assert.deepEqual(employeeState.shifts.map(s=>s.id),['sa']);assert.deepEqual(employeeState.notifications.map(n=>n.id),['ne']);assert.deepEqual(employeeState.notices.map(n=>n.id),['employee-notice']);
});
test('account roles in legacy state cannot grant server permissions',()=>{
 const doc=fixture();doc.state.users[2].role='owner';assert.throws(()=>action(doc,employee,'createInvitation',{businessId:'a',email:'new@example.com',name:'New Member'}));
});
test('employees cannot grant roles, change identity, read or write other businesses',()=>{
 const doc=fixture();const snapshot=action(doc,employee,'loadWorkspaceState',{businessId:'a'}).result.state;
 for(const field of ['role','status','authUid','email','businessId']){
  const changed=clone(snapshot);changed.users.find(u=>u.id==='ea')[field]='forged';assert.throws(()=>save(doc,employee,changed));
 }
 const injected=clone(snapshot);injected.requests.push({id:'forged',businessId:'b',employeeId:'ea',status:'pending'});assert.throws(()=>save(doc,employee,injected));
 const original=JSON.stringify(doc);assert.throws(()=>action(doc,employee,'removeMember',{businessId:'a',userId:'oa'}));assert.equal(JSON.stringify(doc),original);
});
test('employee shift acknowledgement and own pending requests work without allowing roster changes',()=>{
 const doc=fixture();const snapshot=action(doc,employee,'loadWorkspaceState',{businessId:'a'}).result.state;
 snapshot.shifts[0].status='confirmed';snapshot.requests.push({id:'request',businessId:'a',employeeId:'ea',status:'pending',message:'Please change my shift'});
 snapshot.notifications.push({id:'request-note',businessId:'a',userId:'oa',message:'Please review my request'});
 const result=save(doc,employee,snapshot);assert.equal(result.doc.state.shifts.find(s=>s.id==='sa').status,'confirmed');assert.equal(result.doc.state.requests[0].employeeId,'ea');assert.equal(result.doc.state.notifications.at(-1).createdByUserId,'ea');
 const bad=clone(snapshot);bad.shifts[0].date='2099-01-01';assert.throws(()=>save(doc,employee,bad));
 const approval=clone(snapshot);approval.requests[0].status='approved';assert.throws(()=>save(doc,employee,approval));
 const mixed=clone(snapshot);mixed.requests[0].userId='ea';mixed.requests[0].employeeId='oa';assert.throws(()=>save(doc,employee,mixed));
});
test('manager role cannot invite another manager; owners may invite managers',()=>{
 const doc=fixture();doc.bindings[2].role='manager';doc.state.users[2].role='manager';
 assert.throws(()=>action(doc,employee,'createInvitation',{businessId:'a',name:'New Manager',email:'new@example.com',role:'manager'}));
 assert.equal(action(doc,owner,'createInvitation',{businessId:'a',name:'New Manager',email:'new@example.com',role:'manager'}).result.role,'manager');
});
test('invitation acceptance is verified, expiring, one-time and binds exactly the invited business',()=>{
 const created=action(fixture(),owner,'createInvitation',{businessId:'a',name:'New Employee',email:'new@example.com',role:'employee'});const token=created.result.token;
 const invited={uid:'new',email:'new@example.com',verified:true};
 for(const identity of [null,{...invited,verified:false},{...invited,email:'wrong@example.com'}])assert.throws(()=>action(created.doc,identity,'acceptInvitation',{token}));
 const accepted=action(created.doc,invited,'acceptInvitation',{token});assert.equal(accepted.result.businessId,'a');assert.equal(accepted.result.userId,created.result.userId);assert.equal(accepted.doc.bindings.find(b=>b.uid==='new').businessId,'a');assert.deepEqual(accepted.result.state.businesses.map(b=>b.id),['a']);
 assert.throws(()=>action(accepted.doc,invited,'acceptInvitation',{token}));
 assert.throws(()=>run(created.doc,invited,'acceptInvitation',{token},{now:now+8*86400000}));
});
test('resend, revoke and inviter removal invalidate acceptance',()=>{
 const first=action(fixture(),owner,'createInvitation',{businessId:'a',name:'New Employee',email:'new@example.com'});const second=action(first.doc,owner,'createInvitation',{businessId:'a',name:'New Employee',email:'new@example.com'});const invited={uid:'new',email:'new@example.com',verified:true};
 assert.throws(()=>action(second.doc,invited,'acceptInvitation',{token:first.result.token}));
 const revoked=action(second.doc,owner,'revokeInvitation',{businessId:'a',invitationId:second.result.tokenHash});assert.throws(()=>action(revoked.doc,invited,'acceptInvitation',{token:second.result.token}));
 const unavailable=clone(second.doc);unavailable.bindings[0].status='removed';assert.throws(()=>action(unavailable,invited,'acceptInvitation',{token:second.result.token}));
});
test('same email with memberships in two businesses enters the invitation business',()=>{
 const doc=fixture();doc.state.users.push({id:'existing',businessId:'b',authUid:'new',email:'new@example.com',role:'employee',status:'active'});doc.bindings.push({uid:'new',email:'new@example.com',userId:'existing',businessId:'b',role:'employee',status:'active'});
 const created=action(doc,owner,'createInvitation',{businessId:'a',name:'New Employee',email:'new@example.com'});const accepted=action(created.doc,{uid:'new',email:'new@example.com',verified:true},'acceptInvitation',{token:created.result.token});assert.equal(accepted.result.businessId,'a');assert.equal(accepted.doc.bindings.filter(b=>b.uid==='new').length,2);
});
test('owners can save their roster; stale revision and cross-business row injection fail',()=>{
 const doc=fixture();const snapshot=action(doc,owner,'loadWorkspaceState',{businessId:'a'}).result.state;snapshot.shifts[0].date='2026-10-20';
 const saved=save(doc,owner,snapshot);assert.equal(saved.doc.state.shifts.find(s=>s.id==='sb').businessId,'b');assert.equal(saved.doc.revision,2);
 assert.throws(()=>action(saved.doc,owner,'saveWorkspaceState',{businessId:'a',expectedRevision:1,state:snapshot}),{code:'aborted'});
 snapshot.shifts.push({id:'bad',businessId:'b'});assert.throws(()=>save(doc,owner,snapshot));
});
test('only server-created pending owners activate after email verification',()=>{
 const doc=fixture();const newOwner={uid:'new-owner',email:'new-owner@example.com',verified:false};const created=action(doc,newOwner,'createWorkspace',{name:'New Owner',businessName:'New Business'});
 assert.throws(()=>action(created.doc,newOwner,'loadWorkspaceState',{businessId:created.result.businessId}));
 const activated=action(created.doc,{...newOwner,verified:true},'loadWorkspaceState',{businessId:created.result.businessId});assert.equal(activated.result.state.users[0].status,'active');
 const forged=fixture();forged.state.users[2].status='pending_verification';forged.state.users[2].accountSource='workspace_creator';forged.bindings[2].status='pending_verification';assert.throws(()=>action(forged,employee,'repairMyAccess',{businessId:'a'}));
});
test('removed members lose access immediately and cannot use old invitations',()=>{
 const doc=fixture();const removed=action(doc,owner,'removeMember',{businessId:'a',userId:'ea'});assert.throws(()=>action(removed.doc,employee,'loadWorkspaceState',{businessId:'a'}));assert.throws(()=>action(doc,employee,'removeMember',{businessId:'a',userId:'oa'}));
});
test('mail authorizes management and recipient in the same business',()=>{
 const doc=fixture();assert.equal(action(doc,owner,'sendWorkplaceEmail',{businessId:'a',to_email:'ea@example.com'}).result.authorized,true);
 assert.throws(()=>action(doc,owner,'sendWorkplaceEmail',{businessId:'a',to_email:'ob@example.com'}));assert.throws(()=>action(doc,employee,'sendWorkplaceEmail',{businessId:'a',to_email:'ea@example.com'}));
});
