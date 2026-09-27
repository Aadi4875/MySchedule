const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const sendSource=source.slice(source.indexOf('async function sendEmail(payload)'),source.indexOf('\nfunction updateEmailStatus'));
function setup(response={ok:true,json:async()=>({success:true,messageId:'accepted-id'})}){
 const calls=[];
 const ctx={state:{emailConfig:{enabled:true,workerUrl:'https://example.workers.dev'}},EMAILJS_DEFAULTS:{},businessOwnerEmailFor:()=>'',business:()=>({id:'business-1',name:'Test'}),compactEmailHtml:x=>x,saveEmailDebug(){},updateEmailStatus(){},toast(){},console:{error(){}},isValidEmail:x=>x.includes('@'),firebaseAuth:{currentUser:{emailVerified:true,getIdToken:async()=>'test-token'}},fetch:async(...args)=>{calls.push(args);return response;}};
 vm.createContext(ctx);vm.runInContext(sendSource,ctx);
 return {ctx,calls,send:()=>ctx.sendEmail({to_email:'test@example.com',message:'Test',templateType:'invitation'})};
}
test('email sends authenticated workplace context and returns success',async()=>{
 const {send,calls}=setup();const result=await send();assert.equal(result.ok,true);assert.equal(result.messageId,'accepted-id');
 assert.equal(calls[0][1].headers.Authorization,'Bearer test-token');assert.equal(JSON.parse(calls[0][1].body).businessId,'business-1');
});
test('gateway failure reaches the invitation caller',async()=>{
 const {send}=setup({ok:false,status:403,json:async()=>({success:false,error:'Recipient is outside this business.'})});
 const result=await send();assert.equal(result.ok,false);assert.equal(result.error,'Recipient is outside this business.');
});
test('signed-out and unverified users cannot send',async()=>{
 for(const user of [null,{emailVerified:false}]){const {ctx,send,calls}=setup();ctx.firebaseAuth.currentUser=user;assert.equal((await send()).ok,false);assert.equal(calls.length,0);}
});
test('paused mail and network failures return actionable failure results',async()=>{
 const {ctx,send,calls}=setup();ctx.state.emailConfig.enabled=false;assert.match((await send()).error,/paused/);assert.equal(calls.length,0);
 ctx.state.emailConfig.enabled=true;ctx.fetch=async()=>{throw Error('Network unavailable');};assert.equal((await send()).error,'Network unavailable');
});
