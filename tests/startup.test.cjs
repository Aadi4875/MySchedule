const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM,VirtualConsole}=require('jsdom');
test('frontend starts without Firebase and public navigation renders',async()=>{
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));vc.on('error',(...args)=>errors.push(args.join(' ')));
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:8000',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.matchMedia=()=>({matches:false,addListener(){},addEventListener(){}});w.scrollTo=()=>{};w.fetch=async()=>{throw new Error('Network disabled in test');};
 try{
  for(const file of ['config.js','invite-core.js','app.js','invitation-v138.js','invitation-setup-v138.js'])w.eval(fs.readFileSync(file,'utf8')+(file==='app.js'?`
window.testWorkspace = function(role){ state=migrateState(defaultState()); const user={id:'test-user',businessId:'test-business',name:'Test User',email:'test@example.com',role,status:'active'}; state.users.push(user);state.businesses.push({id:'test-business',name:'Test Business',timezone:'Australia/Perth'}); currentUserId=user.id;currentUser=function(){return user;};render(); };`:''));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.match(w.document.querySelector('#app').textContent,/sign in/i);
  for(const mode of ['signup','forgot','login']){w.setAuthMode(mode);assert.ok(w.document.querySelector('#app').textContent.length>100);}
  for(const role of ['owner','manager','employee']){
   w.testWorkspace(role);
   const routes=role==='employee'?['myshifts','teamschedule','requesthub','clock','notifications','profile']:['dashboard','roster','credentials','requests','timesheets','reports','notifications','profile',...(role==='owner'?['settings']:[])];
   for(const route of routes){w.go(route);assert.ok(w.document.querySelector('#view')?.textContent.trim(),`${role}: ${route}`);}
  }
  assert.deepEqual(errors,[]);
 }finally{w.close();}
});
