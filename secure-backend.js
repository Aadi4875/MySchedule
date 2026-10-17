/* All production persistence uses authenticated callable functions. No Firestore fallback. */
(function(){
  'use strict';
  let activeBusiness='';
  let loading=false;
  let saving=false;
  let saveChain=Promise.resolve();
  let queuedSaves=0;
  let stopRefresh=null;
  let displayedRevision=0;
  try{localStorage.removeItem(APP_KEY);}catch(_e){}
  const setup=new URL(location.href).searchParams.get('backend-setup')==='1';
  try{activeBusiness=sessionStorage.getItem('myschedule_secure_business')||'';}catch(_e){}
  function api(name='scheduleApi'){
    if(!initFirebase()||!firebase?.functions)throw new Error('Firebase Authentication and Functions must be configured.');
    return firebase.app().functions('us-central1').httpsCallable(name);
  }
  function select(id){if(!id)return;activeBusiness=id;try{sessionStorage.setItem('myschedule_secure_business',id);}catch(_e){}}
  async function call(action,payload={}){
    const result=(await api()({action,payload:{businessId:activeBusiness||undefined,...payload}})).data;
    if(!result?.ok)throw new Error('The secure backend did not complete this operation.');
    if(result.businessId)select(result.businessId);
    if(result.revision!==undefined)cloudRevision=Number(result.revision);
    return result;
  }
  async function chooseBusiness(){
    if(!firebaseAuth?.currentUser?.emailVerified)return '';
    const result=await call('listWorkspaces');
    if(activeBusiness&&result.workspaces.some(w=>w.businessId===activeBusiness))return activeBusiness;
    if(result.workspaces.length===1){select(result.workspaces[0].businessId);return activeBusiness;}
    if(!result.workspaces.length)return '';
    // Multi-business users explicitly choose their membership, never an arbitrary match.
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='auth-action-dialog';
      const title=document.createElement('h2');title.textContent='Choose your workplace';dialog.appendChild(title);
      for(const workplace of result.workspaces){const button=document.createElement('button');button.textContent=workplace.businessName;button.type='button';button.onclick=()=>{select(workplace.businessId);dialog.remove();resolve(workplace.businessId);};dialog.appendChild(button);}
      dialog.addEventListener('cancel',event=>{event.preventDefault();dialog.remove();resolve('');});document.body.appendChild(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    });
  }
  function incoming(snapshot){
    const result=JSON.parse(JSON.stringify(snapshot));
    for(const row of result.noticeReads||[]){row.businessId=row.businessId||activeBusiness;row.id=row.id||row.noticeId+':'+row.userId;}
    return result;
  }
  function apply(result){if(result.state){state=migrateState(result.state);cloudRevision=Number(result.revision||0);displayedRevision=cloudRevision;}return result;}
  window.MyScheduleSecureBackend={call,apply,select,enabled:true};
  window.__v135CompatCall=async function(action,payload={}){return call(action,payload);};
  loadFirebaseState=async function(){
    if(!firebaseAuth?.currentUser?.emailVerified)return null;
    if(!await chooseBusiness())throw new Error('No workplace is linked to this login. Open your workplace invitation, or create your business account.');
    return (await call('loadWorkspaceState')).state;
  };
  loadState=async function(){
    // Invitations take priority over any remembered owner session on this device.
    try{if(sessionStorage.getItem('myschedule_v133_invite_token')||localStorage.getItem('myschedule_v133_invite_token')){clearCurrentSession();return migrateState(defaultState());}}catch(_e){}
    // Restore only this tab's existing session from the server, never old browser data.
    if(firebaseAuth?.currentUser?.emailVerified&&currentUserId){
      try{return migrateState(await loadFirebaseState());}catch(error){clearCurrentSession();toast(error.message);}
    }
    return migrateState(defaultState());
  };
  saveFirebaseState=function(snapshot){
    if(!firebaseAuth?.currentUser?.emailVerified||!activeBusiness)return Promise.resolve(false);
    const toSave=incoming(snapshot||state);const businessAtSave=activeBusiness;
    queuedSaves++;saving=true;
    saveChain=saveChain.then(async()=>{
      try{
        if(activeBusiness!==businessAtSave)throw new Error('Workplace changed before saving. Reload and retry.');
        const result=await call('saveWorkspaceState',{businessId:businessAtSave,state:toSave,expectedRevision:cloudRevision});
        cloudRevision=Number(result.revision);displayedRevision=cloudRevision;return true;
      }catch(error){toast(error.message||'Changes were not saved. Reload the workplace and retry.');return false;}
      finally{queuedSaves--;saving=queuedSaves>0;}
    });
    return saveChain;
  };
  startFirebaseLiveUpdates=function(){
    if(stopRefresh)return;
    const timer=setInterval(async()=>{
      if(loading||saving||document.hidden||!currentUser()||!firebaseAuth?.currentUser?.emailVerified)return;
      loading=true;try{const result=await call('loadWorkspaceState');if(Number(result.revision)>displayedRevision){state=migrateState(result.state);displayedRevision=Number(result.revision);render();}}
      catch(error){console.warn('Secure refresh paused',error.code||'unavailable');}finally{loading=false;}
    },30000);
    stopRefresh=()=>{clearInterval(timer);stopRefresh=null;};firebaseLiveUnsubscribe=stopRefresh;
  };
  window.sendEmail=sendEmail=async function(payload){
    try{
      const result=(await api('sendWorkplaceEmail')({...payload,businessId:payload.businessId||activeBusiness})).data;
      updateEmailStatus(payload.noteId,result.ok?'sent_real':'failed',result.ok?'Email accepted by provider.':'Email was not sent.');return result;
    }catch(error){updateEmailStatus(payload.noteId,'failed',error.message);return {ok:false,error:error.message};}
  };
  window.removeUser=removeUser=async function(userId){
    if(!confirm('Remove this member’s workplace access?'))return;
    try{apply(await call('removeMember',{userId}));renderContent();toast('Workplace access removed.');}catch(error){toast(error.message);}
  };
  cloudStatusBadge=function(){return '<span class="badge good">Server-authorized workplace</span>';};
  // Bootstrap is an administrator-only maintenance action, outside ordinary signup.
  if(setup){
    window.initializeSecureBackend=async function(){
      try{
        const auth=requireAuth();
        if(!auth.currentUser){await auth.signInWithEmailAndPassword(normalizeEmail(el('login-email')?.value),String(el('login-password')?.value||''));}
        await auth.currentUser.reload();await auth.currentUser.getIdToken(true);
        const preview=await call('inspectLegacyWorkspaces');
        if(preview.initialized)return toast('The backend is already initialized. Sign in normally.');
        const names=preview.workspaces.map(w=>w.name).join(', ');
        if(!confirm('Initialize secure access for '+(names||'a new empty project')+'? A private backup will be saved. Other existing members will need a new invitation.'))return;
        await call('initializeBackend',{businessIds:preview.workspaces.map(w=>w.businessId)});
        history.replaceState(null,'',location.pathname);toast('Backend initialized. Existing employees now need new invitations. Sign in to continue.');
      }catch(error){toast(error.message||'Initialization failed.');}
    };
    const observer=new MutationObserver(()=>{
      const panel=document.querySelector('.landing-auth-card');
      if(!panel||panel.querySelector('#secure-setup-button'))return;
      const button=document.createElement('button');button.id='secure-setup-button';button.type='button';button.textContent='Administrator: initialize secure backend';button.onclick=window.initializeSecureBackend;panel.appendChild(button);
    });observer.observe(document.documentElement,{childList:true,subtree:true});
  }
  window.__MYSCHEDULE_RESOLVE_SECURE?.();
})();
