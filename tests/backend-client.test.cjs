'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
const {run,shape}=require('../functions/core.cjs');
function fixture(){const users=[{id:'owner',businessId:'a',name:'Owner',email:'owner@example.com',authUid:'owner',role:'owner',status:'active'},{id:'employee',businessId:'a',name:'Employee',email:'employee@example.com',authUid:'employee',role:'employee',status:'active'}];return {securityVersion:150,revision:1,state:shape({businesses:[{id:'a',name:'A',businessCode:'A',storeCode:'A'}],users}),bindings:users.map(u=>({uid:u.id,userId:u.id,businessId:'a',email:u.email,role:u.role,status:'active'}))};}
async function frontend(role){
 const vc=new VirtualConsole();const dom=new JSDOM(fs.readFileSync('index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,''),{url:'https://aadi4875.github.io/MySchedule/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});w.fetch=async()=>{throw Error('Network disabled');};
 function script(source){const node=w.document.createElement('script');node.textContent=source;w.document.body.appendChild(node);}
 script(fs.readFileSync('invite-core.js','utf8'));
 script(fs.readFileSync('app.js','utf8')+'\nwindow.bindTestAuth=function(user){firebaseAuth={currentUser:user};firebaseReady=true;firebaseDb={};};window.applyTestState=function(s){state=migrateState(s);};window.getTestState=()=>state;');
 await new Promise(r=>setTimeout(r,20));
 let doc=fixture();const calls=[];const user={uid:role,email:role+'@example.com',emailVerified:true};w.bindTestAuth(user);
 w.firebase={functions:true,app:()=>({functions:()=>({httpsCallable:name=>async input=>{
  calls.push({name,input:JSON.parse(JSON.stringify(input))});const action=input.action,payload=JSON.parse(JSON.stringify(input.payload||{}));const result=run(doc,{uid:user.uid,email:user.email,verified:true},action,payload);doc=result.doc;return {data:result.result};
 }})})};
 script(fs.readFileSync('secure-backend.js','utf8'));script(fs.readFileSync('invitation-v138.js','utf8'));
 const state=await w.loadFirebaseState();w.applyTestState(state);
 return {dom,w,calls,doc:()=>doc};
}
test('real frontend migrations round-trip through owner and employee authorized saves',async()=>{
 for(const role of ['owner','employee']){
  const f=await frontend(role);
  try{const ok=await f.w.saveFirebaseState(f.w.getTestState());assert.equal(ok,true,role+': '+f.w.document.getElementById('toast').textContent+' '+JSON.stringify(f.w.getTestState().users));assert.ok(f.calls.every(c=>c.name==='scheduleApi'));}
  finally{f.dom.window.close();}
 }
});
test('secure invitation bridge uses callable operations without direct Firestore transactions',async()=>{
 const f=await frontend('owner');
 try{
  const result=await f.w.MyScheduleInvitationV138.createInvitationAtomic({name:'New Employee',email:'new@example.com',role:'employee'});
  assert.equal(result.businessId,'a');assert.equal(result.token.length,64);assert.ok(f.calls.some(c=>c.input.action==='createInvitation'));
 }finally{f.dom.window.close();}
});

test('existing employee clock-in and clock-out screens save pending records through server authorization',async()=>{
 const f=await frontend('employee');
 try{
  f.w.setCurrentSession('employee');
  f.w.clockIn({emergency:true,reason:'Manager requested emergency shift',note:'Covering a shift'});
  await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(f.doc().state.timesheets.length,1,f.w.document.getElementById('toast').textContent);
  assert.equal(f.doc().state.timesheets[0].status,'open');
  f.w.clockOut();await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(f.doc().state.timesheets[0].status,'pending',f.w.document.getElementById('toast').textContent);
  assert.ok(f.doc().state.timesheets[0].clockOut);
 }finally{f.dom.window.close();}
});
