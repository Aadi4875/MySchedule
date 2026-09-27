const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const sendSource=source.slice(source.indexOf('async function sendEmail(payload)'),source.indexOf('\nfunction updateEmailStatus'));
function setup(response={ok:true,json:async()=>({success:true,messageId:'accepted-id'})}){
 const calls=[];
 const ctx={uuid:()=>require('node:crypto').randomUUID(),state:{emailConfig:{enabled:true,workerUrl:'https://example.workers.dev'}},EMAILJS_DEFAULTS:{},businessOwnerEmailFor:()=>'',business:()=>({id:'business-1',name:'Test'}),compactEmailHtml:x=>x,saveEmailDebug(){},updateEmailStatus(){},toast(){},console:{error(){}},isValidEmail:x=>x.includes('@'),firebaseAuth:{currentUser:{emailVerified:true,getIdToken:async()=>'test-token'}},fetch:async(...args)=>{calls.push(args);return response;}};
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

test('browser request passes the supplied Worker through token verification and Brevo',async()=>{
 const {webcrypto}=require('node:crypto');
 const workerSource=fs.readFileSync('cloudflare-worker/worker-v147.mjs','utf8');
 const {handleRequest}=await import('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'));
 const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk=await webcrypto.subtle.exportKey('jwk',keys.publicKey);jwk.kid='test-key';
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const unsigned=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({aud:'myschedule-8f213',iss:'https://securetoken.google.com/myschedule-8f213',sub:'owner-uid',email:'owner@example.com',email_verified:true,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600});
 const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(unsigned));
 const token=unsigned+'.'+Buffer.from(signature).toString('base64url');
 const firestoreValue=x=>Array.isArray(x)?{arrayValue:{values:x.map(firestoreValue)}}:typeof x==='object'?{mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,firestoreValue(v)]))}}:{stringValue:x};
 const state={users:[{businessId:'business-1',status:'active',authUid:'owner-uid',email:'owner@example.com',role:'owner'},{businessId:'business-1',status:'invited',email:'test@example.com'}]};
 let sent=0;
 const fakeFetch=async(url,options)=>{
  if(url.includes('/jwk/'))return Response.json({keys:[jwk]});
  if(url.includes('firestore.googleapis.com'))return Response.json({fields:{state:firestoreValue(state)}});
  assert.equal(url,'https://api.brevo.com/v3/smtp/email');sent++;
  assert.equal(JSON.parse(options.body).to[0].email,'test@example.com');return Response.json({messageId:'contract-test-message'});
 };
 const {ctx,send}=setup();ctx.firebaseAuth.currentUser.getIdToken=async()=>token;
 ctx.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.action,'send-email');assert.ok(body.requestId);assert.equal(body.templateType,'invitation');assert.equal(body.toName,'test@example.com');
  return handleRequest(new Request(url,{...options,headers:{...options.headers,Origin:'https://aadi4875.github.io'}}),{BREVO_API_KEY:'test-only',FROM_EMAIL:'sender@example.com'},fakeFetch);
 };
 const result=await send();assert.equal(result.ok,true);assert.equal(result.messageId,'contract-test-message');assert.equal(sent,1);
});
