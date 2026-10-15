/* Shared owner verification and same-site Firebase verification action handler. */
(function(){
  'use strict';
  const TOKEN='myschedule_v133_invite_token';
  const PROOF='myschedule_v138_recipient_proof';
  let ownerBusy=false;
  let lastSent=0;
  function auth(){return requireAuth();}
  function cleanUrl(){return new URL(location.pathname,location.origin).href;}
  // Only recover invitation context from this application's own continue URL.
  // Never navigate to a URL supplied by an email action query parameter.
  const actionUrl=new URL(location.href);
  try{
    const target=new URL(actionUrl.searchParams.get('continueUrl')||location.href);
    if(target.origin===location.origin&&target.pathname===location.pathname){
      const token=target.searchParams.get('invite');
      if(token&&/^[a-f0-9]{64}$/i.test(token)){
        if((sessionStorage.getItem(TOKEN)||localStorage.getItem(TOKEN))!==token){
          for(const key of [PROOF,'myschedule_v138_invited_email','myschedule_v133_pending_access']){sessionStorage.removeItem(key);localStorage.removeItem(key);}
        }
        sessionStorage.setItem(TOKEN,token);localStorage.setItem(TOKEN,token);
        const proof=target.searchParams.get('recipient');
        if(proof&&/^[a-f0-9]{64}$/i.test(proof)){sessionStorage.setItem(PROOF,proof);localStorage.setItem(PROOF,proof);}
      }
    }
  }catch(_e){}

  window.showOwnerVerification=function(message='Open the verification email. This page will continue automatically.'){
    const panel=document.querySelector('.landing-auth-card');if(!panel)return;
    panel.innerHTML='<div id="owner-verification" class="v138-form"><h2>Verify your email</h2><p id="owner-verify-email"></p><p id="owner-verify-message" role="status" aria-live="polite"></p><button class="primary full" type="button" onclick="checkOwnerVerification(true)">Continue after verification</button><button type="button" onclick="resendOwnerVerification()">Resend verification email</button><button type="button" onclick="leaveOwnerVerification()">Back to sign in</button></div>';
    document.getElementById('owner-verify-email').textContent=auth().currentUser?.email||'';
    document.getElementById('owner-verify-message').textContent=message;
  };
  function ownerMessage(message){const node=document.getElementById('owner-verify-message');if(node)node.textContent=message;}
  window.resendOwnerVerification=async function(){
    if(ownerBusy)return;
    if(Date.now()-lastSent<30000)return ownerMessage('Wait 30 seconds before sending another email.');
    ownerBusy=true;
    try{await auth().currentUser.sendEmailVerification({url:cleanUrl()});lastSent=Date.now();ownerMessage('Verification email sent. Check Inbox, Spam or Junk.');}
    catch(error){ownerMessage(error.message||'Could not send verification. Try again.');}
    finally{ownerBusy=false;}
  };
  window.checkOwnerVerification=async function(manual=false){
    if(ownerBusy||document.hidden||!document.getElementById('owner-verification'))return;
    ownerBusy=true;
    try{
      const user=auth().currentUser;if(!user)throw new Error('Sign in again to continue.');
      await user.reload();
      if(!user.emailVerified){if(manual)ownerMessage('Open the verification link in your email first.');return;}
      await user.getIdToken(true);
      const cloud=await loadFirebaseState();if(!cloud)throw new Error('Could not load your workspace. Try again.');
      state=migrateState(cloud);
      const profile=state.users.find(u=>u.authUid===user.uid&&normalizeEmail(u.email)===normalizeEmail(user.email)&&u.role==='owner'&&['active','pending_verification'].includes(u.status)&&['workspace_creator','owner_signup'].includes(u.accountSource));
      if(!profile)throw new Error('No owner workspace is linked to this account. Sign in or use your invitation.');
      profile.status='active';profile.emailVerified=true;
      if(!(await saveFirebaseState(state)))throw new Error('Could not save your verified workspace. Try again.');
      await finishAuthLogin(user,{userId:profile.id,businessId:profile.businessId});
      startFirebaseLiveUpdates();
    }catch(error){ownerMessage(error.message||'Could not finish verification. Try again.');}
    finally{ownerBusy=false;}
  };
  window.leaveOwnerVerification=async function(){await auth().signOut();clearCurrentSession();render();};
  window.addEventListener('focus',()=>window.checkOwnerVerification());
  document.addEventListener('visibilitychange',()=>window.checkOwnerVerification());
  setInterval(()=>window.checkOwnerVerification(),5000);

  function actionDialog(title){
    const dialog=document.createElement('dialog');dialog.className='auth-action-dialog';
    dialog.innerHTML='<h2></h2><p class="auth-action-message" role="status" aria-live="polite"></p><div class="auth-action-content"></div>';
    dialog.querySelector('h2').textContent=title;document.body.appendChild(dialog);
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    return dialog;
  }
  async function handleVerificationAction(){
    const mode=actionUrl.searchParams.get('mode');
    const code=actionUrl.searchParams.get('oobCode');if(!mode||!code)return;
    history.replaceState(null,'',location.pathname+location.hash);
    if(mode==='resetPassword'){
      const dialog=actionDialog('Reset your password');
      const message=dialog.querySelector('.auth-action-message');
      try{
        const email=await auth().verifyPasswordResetCode(code);
        message.textContent='Choose a new password for '+email;
        dialog.querySelector('.auth-action-content').innerHTML='<form id="auth-reset-form"><label for="auth-reset-password">New password</label><input id="auth-reset-password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required><p>Use uppercase, lowercase, a number and a symbol.</p><button type="button" id="auth-reset-show">Show password</button><button class="primary" type="submit">Save password</button></form>';
        dialog.querySelector('#auth-reset-show').onclick=()=>{const input=dialog.querySelector('input');input.type=input.type==='password'?'text':'password';};
        dialog.querySelector('form').onsubmit=async event=>{
          event.preventDefault();const password=dialog.querySelector('input').value;
          if(!window.MyScheduleInvitationSetupV138?.passwordStatus(password).valid){message.textContent='Use 8–128 characters with uppercase, lowercase, a number and a symbol.';return;}
          const button=dialog.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;
          try{await auth().confirmPasswordReset(code,password);dialog.querySelector('input').value='';dialog.remove();render();window.v138ShowSignIn?.();toast('Password saved. Sign in with your new password.');}
          catch(error){message.textContent=error.message||'This link expired. Request a new password reset.';}
          finally{button.disabled=false;}
        };
      }catch(_error){message.textContent='This password reset link expired or was already used. Request a new reset from Sign in.';}
      const close=document.createElement('button');close.type='button';close.textContent='Back to sign in';close.onclick=()=>dialog.remove();dialog.appendChild(close);
      return;
    }
    if(!['verifyEmail','verifyAndChangeEmail','recoverEmail'].includes(mode)){toast('This email action is not supported. Request a new link from MySchedule.');return;}
    try{
      await auth().applyActionCode(code);
      const user=auth().currentUser;
      if(user){await user.reload();await user.getIdToken(true);}
      if(mode==='recoverEmail'){
        await auth().signOut();clearCurrentSession();render();toast('Your previous email was restored. Reset your password from Sign in to protect your account.');return;
      }
      toast('Email verified. Continue to your workplace.');
      window.checkOwnerVerification();
      window.dispatchEvent(new Event('focus'));
    }catch(_error){toast('This verification link expired or was already used. Return to setup and resend verification, or sign in if already verified.');}
  }
  setTimeout(handleVerificationAction,0);
})();
