/* Run only against the local emulator; never targets a production Firebase host. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const host=process.env.FIRESTORE_EMULATOR_HOST;
if(!host||!/^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(host))throw Error('A loopback Firestore emulator is required.');
const authHost=process.env.FIREBASE_AUTH_EMULATOR_HOST;
if(!authHost||!/^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(authHost))throw Error('A loopback Auth emulator is required.');
const root=`http://${host}/v1/projects/demo-myschedule/databases/(default)/documents`;
test('database rules deny all browser reads and writes, including authenticated accounts',async()=>{
 const signup=await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'rules-test@example.com',password:'RulesTest123!',returnSecureToken:true})});
 assert.equal(signup.ok,true);const {idToken}=await signup.json();
 for(const token of [null,idToken])for(const path of ['apps/myschedule_public_launch','publicInvitations/test','migrationBackups/before_v150','mailLimits/test']){
  const headers=token?{Authorization:'Bearer '+token}:{};
  const read=await fetch(root+'/'+path,{headers});assert.equal(read.status,403,path+' read');
  const write=await fetch(root+'/'+path,{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({fields:{test:{stringValue:'no'}}})});assert.equal(write.status,403,path+' write');
 }
});
