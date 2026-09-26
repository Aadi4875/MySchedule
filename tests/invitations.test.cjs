const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../invite-core.js');
const raw={name:'Test Member',email:'member@example.com',role:'employee',hireDate:'2026-09-26'};
function context(){let n=0;return {businessId:'a',inviterId:'owner',inviterRole:'owner',inviterEmail:'owner@example.com',today:'2026-09-26',now:'2026-09-26T00:00:00Z',expiresAt:'2026-10-03T00:00:00Z',tokenHash:'a'.repeat(64),id:()=>`id${++n}`,ref:()=>`ref${++n}`};}
test('reinvitations revoke only invitations in the selected business',()=>{
 const state={businesses:[{id:'a',name:'A'},{id:'b',name:'B'}],users:[],accessInvitations:[{id:'other',businessId:'b',email:raw.email,status:'pending'},{id:'old',businessId:'a',email:raw.email,status:'pending'}]};
 const result=core.applyInvitation(state,raw,context());
 assert.equal(result.state.accessInvitations.find(i=>i.id==='other').status,'pending');
 assert.equal(result.state.accessInvitations.find(i=>i.id==='old').status,'revoked');
 assert.deepEqual(result.result.revokedTokenHashes,['old']);
 assert.equal(state.accessInvitations[1].status,'pending');
});
test('managers cannot grant manager access',()=>assert.throws(()=>core.validateInput({...raw,role:'manager'},{...context(),inviterRole:'manager'}),{code:'manager-role-denied'}));
test('invalid calendar dates and self invitations are rejected',()=>{
 assert.throws(()=>core.validateInput({...raw,hireDate:'2026-02-30'},context()),{code:'invalid-date'});
 assert.throws(()=>core.validateInput({...raw,email:' OWNER@example.com '},context()),{code:'self-invite'});
});
