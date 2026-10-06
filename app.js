const KEY='dc_audit_system_v2';
const LOCAL_USER_KEY='dc_audit_local_user_v1';
const SESSION_KEY='dc_audit_authenticated_user_v1';
const DEFAULT_AUDITOR_PASSWORD='ChangeMe123!';
const DEFAULT_MANAGER_USERNAME='manager';
const DEFAULT_MANAGER_PASSWORD='Manager123!';
const SHARED_FILE_NAME='DC_Quality_Audit_Shared_Data.json';
const SHARED_CONFIG_KEY='dc_audit_shared_folder_v1';
let db=JSON.parse(localStorage.getItem(KEY)||'null')||{audits:[],user:'',auditors:['Auditor 1','Auditor 2','Auditor 3','Auditor 4','Auditor 5'],garmentTemplates:[],suppliers:[]};
if(!Array.isArray(db.auditorAccounts)) db.auditorAccounts=[];
if(!db.managerAccount) db.managerAccount={username:DEFAULT_MANAGER_USERNAME,passwordHash:null};
let authenticatedUser=localStorage.getItem(SESSION_KEY)||'';
let authReady=false;
if(localStorage.getItem(LOCAL_USER_KEY) && !authenticatedUser) localStorage.removeItem(LOCAL_USER_KEY);
let sharedDirHandle=null;
let sharedFileHandle=null;
let sharedLastModified=0;
let sharedSyncBusy=false;
let sharedSyncTimer=null;
let sharedStatus='Not connected';
if(!Array.isArray(db.suppliers)) db.suppliers=[];
if(!Array.isArray(db.defectOptions)) db.defectOptions=[];
if(!Array.isArray(db.auditors)||!db.auditors.length) db.auditors=['Auditor 1','Auditor 2','Auditor 3','Auditor 4','Auditor 5'];
function accountUsername(name){ return String(name||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'') || 'auditor'; }
async function hashPassword(password){ const data=new TextEncoder().encode(String(password||'')); const buf=await crypto.subtle.digest('SHA-256',data); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function migrateAccounts(){
  if(!Array.isArray(db.auditorAccounts)) db.auditorAccounts=[];
  const existing=new Map(db.auditorAccounts.map(a=>[String(a.name||'').toLowerCase(),a]));
  db.auditors.forEach((name,i)=>{ if(!existing.has(String(name).toLowerCase())) db.auditorAccounts.push({id:crypto.randomUUID(),name,username:accountUsername(name)||`auditor${i+1}`,passwordHash:null,title:'Auditor'}); });
  db.auditorAccounts=db.auditorAccounts.filter(a=>db.auditors.includes(a.name));
  db.auditorAccounts.forEach(a=>{if(!String(a.title||'').trim())a.title='Auditor';});
  if(!db.managerAccount) db.managerAccount={username:DEFAULT_MANAGER_USERNAME,passwordHash:null};
}
migrateAccounts();
if(!Array.isArray(db.garmentTemplates)) db.garmentTemplates=[];
if(!db.garmentTemplates.length){db.garmentTemplates=[
 {id:crypto.randomUUID(),name:'Shirt',poms:['Chest','Bottom Opening','Across Shoulder','Sleeve Length','Body Length','Neck'].map(p=>({pom:p,spec:'',tolMinus:'',tolPlus:''}))},
 {id:crypto.randomUUID(),name:'Pant',poms:['Waist','Hip','Front Rise','Back Rise','Inseam','Outseam','Leg Opening'].map(p=>({pom:p,spec:'',tolMinus:'',tolPlus:''}))},
 {id:crypto.randomUUID(),name:'Short',poms:['Waist','Hip','Inseam','Outseam','Leg Opening'].map(p=>({pom:p,spec:'',tolMinus:'',tolPlus:''}))}
];}
db.audits.forEach(a=>{if(a.reinspect==='No')a.reinspect='First Audit';else if(a.reinspect==='Yes')a.reinspect='Second Audit';});
let view='queue';
let dashboardShipmentSelection='';
let dashboardTatAuditorSelection='';
let supplierReportSelection='';
const USERS=()=>[...db.auditors,'Manager'];
function currentAccount(){ return db.user==='Manager'?db.managerAccount:db.auditorAccounts.find(a=>a.name===db.user); }
function auditorTitle(name){ return String(db.auditorAccounts.find(a=>a.name===name)?.title||'Auditor'); }
function isManager(){ return db.user==='Manager'; }
function visibleAudits(a){ return isManager()?a:a.filter(x=>x.status==='Available'||x.assigned===db.user); }
function canViewAudit(x){ return isManager()||x.status==='Available'||x.assigned===db.user; }

const sharedPayload=()=>{const copy=JSON.parse(JSON.stringify(db)); delete copy.user; return copy;};
function mergeShared(remote){
  if(!remote||typeof remote!=='object') return;
  const localAudits=Array.isArray(db.audits)?db.audits:[];
  const remoteAudits=Array.isArray(remote.audits)?remote.audits:[];
  const byId=new Map();
  remoteAudits.forEach(a=>byId.set(a.id,a));
  localAudits.forEach(a=>{
    const r=byId.get(a.id);
    if(!r || (Number(a.updatedAt)||0) >= (Number(r.updatedAt)||0)) byId.set(a.id,a);
  });
  db.audits=[...byId.values()];
  if(Array.isArray(remote.auditors)) db.auditors=remote.auditors;
  if(Array.isArray(remote.garmentTemplates)) db.garmentTemplates=remote.garmentTemplates;
  if(Array.isArray(remote.suppliers)) db.suppliers=remote.suppliers;
  if(Array.isArray(remote.defectOptions)) db.defectOptions=remote.defectOptions;
  if(Array.isArray(remote.auditorAccounts)) { db.auditorAccounts=remote.auditorAccounts; db.auditorAccounts.forEach(a=>{if(!String(a.title||'').trim())a.title='Auditor';}); }
  if(remote.managerAccount) db.managerAccount=remote.managerAccount;
}
async function ensureSharedFile(){
  if(!sharedDirHandle) return null;
  try{ sharedFileHandle=await sharedDirHandle.getFileHandle(SHARED_FILE_NAME,{create:true}); return sharedFileHandle; }
  catch(e){ sharedStatus='Folder access denied'; return null; }
}
async function readShared(){
  if(!sharedDirHandle || sharedSyncBusy) return;
  try{
    const fh=await ensureSharedFile(); if(!fh) return;
    const file=await fh.getFile(); sharedLastModified=file.lastModified;
    if(file.size){ const remote=JSON.parse(await file.text()); mergeShared(remote); localStorage.setItem(KEY,JSON.stringify(db)); render(); }
    sharedStatus='LIVE';
  }catch(e){ sharedStatus='Sync error'; console.warn(e); }
}
async function writeShared(){
  if(!sharedDirHandle || sharedSyncBusy) return;
  sharedSyncBusy=true;
  try{
    const fh=await ensureSharedFile(); if(!fh){sharedSyncBusy=false;return;}
    // Pull the latest file first so simultaneous auditors adding new audits are merged rather than overwritten.
    const latest=await fh.getFile();
    if(latest.size){ try{ mergeShared(JSON.parse(await latest.text())); }catch(e){} }
    const now=Date.now(); db.updatedAt=now; db.audits.forEach(a=>{ if(!a.updatedAt) a.updatedAt=now; });
    const writable=await fh.createWritable(); await writable.write(JSON.stringify(sharedPayload(),null,2)); await writable.close();
    const saved=await fh.getFile(); sharedLastModified=saved.lastModified; sharedStatus='LIVE';
    localStorage.setItem(KEY,JSON.stringify(db));
  }catch(e){ sharedStatus='Sync error'; console.warn(e); }
  finally{ sharedSyncBusy=false; }
}
function save(){
  const now=Date.now();
  db.updatedAt=now;
  if(Array.isArray(db.audits)) db.audits.forEach(a=>{if(!a.updatedAt)a.updatedAt=now;});
  localStorage.setItem(KEY,JSON.stringify(db));
  if(sharedDirHandle) writeShared();
}
async function connectSharedFolder(){
  if(!window.showDirectoryPicker){ alert('This Windows build needs Microsoft Edge 86+ (or a Chromium browser) for shared OneDrive/SharePoint-folder access.'); return; }
  try{
    const handle=await window.showDirectoryPicker({mode:'readwrite'});
    if(handle.requestPermission){ const perm=await handle.requestPermission({mode:'readwrite'}); if(perm!=='granted'){alert('Write permission was not granted for the selected folder.');return;} }
    sharedDirHandle=handle; sharedStatus='Connecting…';
    localStorage.setItem(SHARED_CONFIG_KEY,JSON.stringify({name:handle.name}));
    await ensureSharedFile();
    const fh=await sharedDirHandle.getFileHandle(SHARED_FILE_NAME,{create:true});
    const file=await fh.getFile();
    if(file.size){ mergeShared(JSON.parse(await file.text())); } else { await writeShared(); }
    localStorage.setItem(KEY,JSON.stringify(db)); sharedStatus='LIVE'; render();
  }catch(e){ if(e?.name!=='AbortError'){sharedStatus='Not connected';alert('Unable to connect to that folder. Please select the OneDrive/SharePoint folder that is synced to this computer.');} }
}
async function disconnectSharedFolder(){ sharedDirHandle=null; sharedFileHandle=null; sharedLastModified=0; sharedStatus='Not connected'; if(sharedSyncTimer){clearInterval(sharedSyncTimer);sharedSyncTimer=null;} render(); }
async function pollShared(){
  if(!sharedDirHandle || sharedSyncBusy) return;
  try{ const fh=await ensureSharedFile(); if(!fh)return; const file=await fh.getFile(); if(file.lastModified!==sharedLastModified){sharedLastModified=file.lastModified; if(file.size){mergeShared(JSON.parse(await file.text()));localStorage.setItem(KEY,JSON.stringify(db));render();} } sharedStatus='LIVE'; }catch(e){sharedStatus='Sync error';}
}
async function initSharedSync(){
  // File-system handles cannot be reliably restored from localStorage, so each computer selects the shared folder once per app session.
  const hint=JSON.parse(localStorage.getItem(SHARED_CONFIG_KEY)||'null');
  if(hint?.name) sharedStatus=`Not connected — last folder: ${hint.name}`;
  if(sharedSyncTimer) clearInterval(sharedSyncTimer);
  sharedSyncTimer=setInterval(pollShared,3000);
}

const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const dt=x=>x?new Date(x).toLocaleString():'—';
function formatMs(ms){ const total=Math.max(0,Math.floor((Number(ms)||0)/1000)), h=Math.floor(total/3600), m=Math.floor((total%3600)/60), sec=total%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
function duration(start,end,pausedMs=0){ if(!start||!end)return '—'; const ms=Math.max(0,new Date(end)-new Date(start)-Math.max(0,Number(pausedMs)||0)); const total=Math.floor(ms/1000), h=Math.floor(total/3600), m=Math.floor((total%3600)/60), sec=total%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
function liveDuration(x){ if(!x?.start)return '00:00:00'; const paused=Number(x.pausedMs)||0; const activePause=x.pauseStarted?Math.max(0,Date.now()-new Date(x.pauseStarted).getTime()):0; const ms=Math.max(0,Date.now()-new Date(x.start).getTime()-paused-activePause); const total=Math.floor(ms/1000),h=Math.floor(total/3600),m=Math.floor((total%3600)/60),sec=total%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
function pill(v){return `<span class="pill ${String(v).toLowerCase().replace(' ','')}">${esc(v)}</span>`}
function iosBridge(payload){try{window.webkit?.messageHandlers?.iosBridge?.postMessage(payload)}catch(e){}}
function nav(){
 document.querySelectorAll('nav button,[data-view]').forEach(b=>{if(b.dataset.view)b.onclick=()=>{if(b.dataset.view==='more'){document.getElementById('mobileMore')?.classList.toggle('hidden');return;}document.getElementById('mobileMore')?.classList.add('hidden');view=b.dataset.view;render()}});
 const ml=document.getElementById('mobileLogout'); if(ml) ml.onclick=()=>{document.getElementById('mobileMore')?.classList.add('hidden');logout()};
} 
window.iosSetView=function(nextView){view=String(nextView||'queue');render();};
window.iosGetState=function(){return {authenticated:authReady,user:db.user||'',manager:isManager(),view};};
function render(){
 if(!authReady){ document.querySelectorAll('nav button').forEach(b=>b.classList.add('hidden')); document.getElementById('userbar').innerHTML=''; document.getElementById('app').innerHTML=loginHtml(); bindLogin(); return; }
 document.querySelectorAll('nav button').forEach(b=>b.classList.remove('hidden'));
 document.querySelector('nav button[data-view="dashboard"]')?.classList.toggle('hidden',db.user!=='Manager');
 document.querySelector('nav button[data-view="manager"]')?.classList.toggle('hidden',db.user!=='Manager');
 document.querySelector('nav button[data-view="managerQueue"]')?.classList.toggle('hidden',db.user!=='Manager');
 document.querySelector('nav button[data-view="supplierReport"]')?.classList.toggle('hidden',db.user!=='Manager');
 document.querySelectorAll('#mobileMore [data-manager-only]').forEach(b=>b.classList.toggle('hidden',db.user!=='Manager'));
 document.getElementById('mobileNav')?.classList.toggle('hidden',!authReady);
 document.getElementById('mobileMore')?.classList.add('hidden');
 if(db.user!=='Manager' && (view==='dashboard'||view==='manager'||view==='managerQueue'||view==='supplierReport')) view='queue';
 document.getElementById('userbar').innerHTML=`<span class="sync-indicator ${sharedDirHandle?'sync-live':'sync-offline'}">● ${esc(sharedStatus)}</span><span class="user-label">Signed in: <b>${esc(db.user)}</b>${db.user!=='Manager'?` — ${esc(auditorTitle(db.user))}`:''}</span><button type="button" id="logoutBtn">LOG OUT</button>`;
 document.getElementById('logoutBtn').onclick=logout;
 let a=visibleAudits(db.audits); let html='<div class="container">';
 if(view==='queue')html+=queue(a);if(view==='managerQueue')html+=managerQueue();if(view==='mine')html+=mine(a);if(view==='history')html+=history(a);if(view==='dashboard')html+=dashboard(a);if(view==='supplierReport')html+=supplierReport(a);if(view==='add')html+=add();if(view==='manager')html+=manager();
 html+='</div>';document.getElementById('app').innerHTML=html;bind();
 iosBridge({type:'authState',authenticated:authReady,user:db.user||'',manager:isManager(),view});
}
function loginHtml(){ return `<div class="container login-container"><div class="section login-card"><h2>DC Quality Audit System Login</h2><p class="muted">Sign in with the username and password assigned to your account.</p><form id="loginForm"><label>Username<input id="loginUsername" autocomplete="username" required autofocus></label><label>Password<input id="loginPassword" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">SIGN IN</button><p id="loginError" class="login-error"></p></form><p class="muted small">The Manager can create and manage auditor usernames and passwords from Auditor Management.</p></div></div>`; }
async function bindLogin(){ const f=document.getElementById('loginForm'); if(!f)return; f.onsubmit=async e=>{e.preventDefault();const u=document.getElementById('loginUsername').value.trim().toLowerCase(),p=document.getElementById('loginPassword').value;const err=document.getElementById('loginError');let name='';let account=null;if(u===String(db.managerAccount?.username||DEFAULT_MANAGER_USERNAME).toLowerCase()){account=db.managerAccount;name='Manager';}else{account=db.auditorAccounts.find(a=>String(a.username||'').toLowerCase()===u);name=account?.name||'';}if(!account){err.textContent='Invalid username or password.';return;}if(!account.passwordHash){err.textContent='This account has no password assigned. Ask the Manager to set one.';return;}if(await hashPassword(p)!==account.passwordHash){err.textContent='Invalid username or password.';return;}db.user=name;authenticatedUser=name;authReady=true;localStorage.setItem(SESSION_KEY,name);localStorage.setItem(LOCAL_USER_KEY,name);render();}; }
function logout(){ authReady=false;authenticatedUser='';db.user='';localStorage.removeItem(SESSION_KEY);localStorage.removeItem(LOCAL_USER_KEY);view='queue';render(); }
function managerQueue(){
 if(!isManager()) return '';
 const rows=db.audits.filter(x=>x.status!=='Completed').sort((a,b)=>new Date(a.ready||a.created||0)-new Date(b.ready||b.created||0));
 return `<div class="auditrow"><div><h2>Audit Queue</h2><p class="muted">Manager-only view of every audit that has not been completed, including unassigned and in-progress work.</p></div><div><button type="button" id="refreshManagerQueue">REFRESH</button></div></div><div class="cards"><div class="card"><b>Total Open</b><div class="num">${rows.length}</div></div><div class="card"><b>Unassigned</b><div class="num">${rows.filter(x=>!x.assigned).length}</div></div><div class="card"><b>In Progress</b><div class="num">${rows.filter(x=>x.status==='In Progress').length}</div></div><div class="card"><b>Paused</b><div class="num">${rows.filter(x=>x.status==='Paused').length}</div></div></div><div class="tablewrap"><table><thead><tr><th>PO</th><th>Style</th><th>Supplier</th><th>Shipment</th><th>Priority</th><th>Status</th><th>Auditor</th><th>Title</th><th>Ready</th><th>Started</th><th>Active Time</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.supplier)}</td><td>${esc(x.shipmentNumber||'—')}${x.shipmentSeq&&x.shipmentTotal?` (${esc(x.shipmentSeq)}/${esc(x.shipmentTotal)})`:''}</td><td>${pill(x.priority||'Normal')}</td><td>${pill(x.status||'—')}</td><td>${esc(x.assigned||'Unassigned')}</td><td>${x.assigned?esc(auditorTitle(x.assigned)):'—'}</td><td>${dt(x.ready)}</td><td>${dt(x.start)}</td><td>${x.status==='Paused'?duration(x.start,x.pauseStarted||new Date().toISOString(),x.pausedMs):x.status==='In Progress'?liveDuration(x):'—'}</td><td>${x.status==='Available'?`<button class="primary" data-take="${x.id}">ASSIGN / TAKE</button>`:`<button data-open="${x.id}">OPEN</button>`}</td></tr>`).join('')||'<tr><td colspan="12">No incomplete audits are currently in the queue.</td></tr>'}</tbody></table></div>`;
}

function queue(a){let rows=a.filter(x=>x.status==='Available').sort((a,b)=>({Urgent:0,Priority:1,Normal:2}[a.priority]-({Urgent:0,Priority:1,Normal:2}[b.priority])));return `<h2>Available Audits</h2><p class="muted">Audits ready for an auditor to claim.</p><div class="tablewrap"><table><thead><tr><th>PO</th><th>Style</th><th>Supplier</th><th>Qty</th><th>Priority</th><th>Ready</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.supplier)}</td><td>${esc(x.qty)}</td><td>${pill(x.priority)}</td><td>${dt(x.ready)}</td><td><button class="primary" data-take="${x.id}">TAKE AUDIT</button></td></tr>`).join('')||'<tr><td colspan="7">No audits available.</td></tr>'}</tbody></table></div>`}
function mine(a){let rows=a.filter(x=>(x.status==='In Progress'||x.status==='Paused')&&x.assigned===db.user);return `<h2>My Audits</h2><p class="muted">Paused audits remain assigned to you and can be resumed later.</p><div class="tablewrap"><table><thead><tr><th>PO</th><th>Style</th><th>Supplier</th><th>Priority</th><th>Status</th><th>Started</th><th>Active Time</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.supplier)}</td><td>${esc(x.priority)}</td><td>${pill(x.status)}</td><td>${dt(x.start)}</td><td>${x.status==='Paused'?duration(x.start,x.pauseStarted||new Date().toISOString(),x.pausedMs):'Running'}</td><td>${x.status==='Paused'?`<button class="primary" data-resume="${x.id}">RESUME AUDIT</button>`:`<button class="primary" data-open="${x.id}">OPEN AUDIT</button>`}<button data-open="${x.id}">MANAGE</button></td></tr>`).join('')||'<tr><td colspan="8">No active or paused audits.</td></tr>'}</tbody></table></div>`}
function history(a){let rows=a.filter(x=>x.status==='Completed').sort((a,b)=>new Date(b.complete)-new Date(a.complete));return `<div class="auditrow"><div><h2>Audit History</h2><p class="muted">Completed audits remain here for reporting, editing, and printing.</p></div><div><button id="printSelected">REPORT SELECTED</button><button class="primary" id="printAll">REPORT ALL</button></div></div><div class="toolbar"><label>Search PO Number<input id="historySearch" placeholder="Enter full or partial PO number"></label><button id="clearHistorySearch">CLEAR</button></div><div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="selectAll"></th><th>PO</th><th>Style</th><th>Supplier</th><th>Auditor</th><th>Title</th><th>Result</th><th>Completed</th><th></th></tr></thead><tbody id="historyBody">${historyRows(rows)}</tbody></table></div>`}
function historyRows(rows){return rows.map(x=>`<tr><td><input type="checkbox" class="reportSelect" value="${x.id}"></td><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.supplier)}</td><td>${esc(x.assigned)}</td><td>${x.assigned?esc(auditorTitle(x.assigned)):'—'}</td><td>${pill(x.result||'—')}</td><td>${dt(x.complete)}</td><td><button data-edit="${x.id}">EDIT</button><button data-print="${x.id}">REPORT</button>${db.user==='Manager'?`<button class="danger" data-delete-audit="${x.id}">DELETE</button>`:''}</td></tr>`).join('')||'<tr><td colspan="9">No completed audits.</td></tr>'}
function auditorProfileHtml(a,name){
 const completed=a.filter(x=>x.status==='Completed'&&x.assigned===name),all=a.filter(x=>x.assigned===name),passed=completed.filter(x=>String(x.result||'').toUpperCase()==='PASS').length;
 const passPct=completed.length?(passed/completed.length*100).toFixed(1):'0.0';
 const timed=completed.filter(x=>x.start&&x.complete).map(x=>(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5);
 const avg=timed.length?(timed.reduce((p,n)=>p+n,0)/timed.length).toFixed(2):'0.00';
 let major=0,minor=0,oot=0,meas=0;
 completed.forEach(x=>{const ds=defectAcceptance(x);major+=ds.major;minor+=ds.minor;const st=auditPomStats(x);oot+=st.totalOOTMeasurements;meas+=st.totalMeasurements;});
 const types={};completed.forEach(x=>{const t=x.garmentTypeName||x.garmentType||'Unspecified';if(!types[t])types[t]={count:0,pass:0,totalHrs:0,timed:0};types[t].count++;if(String(x.result||'').toUpperCase()==='PASS')types[t].pass++;if(x.start&&x.complete){types[t].totalHrs+=(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5;types[t].timed++;}});
 const typeRows=Object.entries(types).sort((a,b)=>a[0].localeCompare(b[0])).map(([t,v])=>`<tr><td>${esc(t)}</td><td>${v.count}</td><td>${v.pass}/${v.count} (${v.count?(v.pass/v.count*100).toFixed(1):'0.0'}%)</td><td>${v.timed?(v.totalHrs/v.timed).toFixed(2)+' hrs':'—'}</td></tr>`).join('')||'<tr><td colspan="4">No completed audits yet.</td></tr>';
 return `<div class="modalbox auditor-profile-overlay"><div class="modalcontent auditor-profile"><div class="auditrow"><div><h2>${esc(name)} — Auditor Profile</h2><p class="muted">Statistics based on audits assigned to this auditor.</p></div><div><button type="button" class="primary" id="printAuditorProfile">PRINT PROFILE</button><button type="button" id="closeAuditorProfile">CLOSE</button></div></div><div class="cards profile-cards"><div class="card">Assigned Audits<div class="num">${all.length}</div></div><div class="card">Completed<div class="num">${completed.length}</div></div><div class="card">Pass Rate<div class="num">${passPct}%</div></div><div class="card">Avg Completion<div class="num">${avg} hrs</div></div><div class="card">Measurements<div class="num">${meas}</div></div><div class="card">OOT Measurements<div class="num">${oot}</div></div><div class="card">Major Defects<div class="num">${major}</div></div><div class="card">Minor Defects<div class="num">${minor}</div></div></div><div class="section"><h3>Performance by Garment Type</h3><div class="tablewrap"><table><thead><tr><th>Garment Type</th><th>Completed</th><th>Pass Rate</th><th>Avg Completion</th></tr></thead><tbody>${typeRows}</tbody></table></div></div></div></div>`;
}
function showAuditorProfile(name){const host=document.getElementById('modal');if(!host)return;host.className='modalbox';host.innerHTML=auditorProfileHtml(db.audits,name);document.getElementById('closeAuditorProfile').onclick=()=>{host.className='hidden';host.innerHTML='';};document.getElementById('printAuditorProfile').onclick=()=>printAuditorProfile(name);}
function printAuditorProfile(name){
 const completed=db.audits.filter(x=>x.status==='Completed'&&x.assigned===name),all=db.audits.filter(x=>x.assigned===name),passed=completed.filter(x=>String(x.result||'').toUpperCase()==='PASS').length;
 const passPct=completed.length?(passed/completed.length*100).toFixed(1):'0.0';
 const timed=completed.filter(x=>x.start&&x.complete).map(x=>(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5);
 const avg=timed.length?(timed.reduce((p,n)=>p+n,0)/timed.length).toFixed(2):'0.00';
 let major=0,minor=0,oot=0,meas=0; completed.forEach(x=>{const ds=defectAcceptance(x);major+=ds.major;minor+=ds.minor;const st=auditPomStats(x);oot+=st.totalOOTMeasurements;meas+=st.totalMeasurements;});
 const types={};completed.forEach(x=>{const t=x.garmentTypeName||x.garmentType||'Unspecified';if(!types[t])types[t]={count:0,pass:0,totalHrs:0,timed:0};types[t].count++;if(String(x.result||'').toUpperCase()==='PASS')types[t].pass++;if(x.start&&x.complete){types[t].totalHrs+=(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5;types[t].timed++;}});
 const typeRows=Object.entries(types).sort((a,b)=>a[0].localeCompare(b[0])).map(([t,v])=>`<tr><td>${esc(t)}</td><td>${v.count}</td><td>${v.pass}/${v.count} (${v.count?(v.pass/v.count*100).toFixed(1):'0.0'}%)</td><td>${v.timed?(v.totalHrs/v.timed).toFixed(2)+' hrs':'—'}</td></tr>`).join('')||'<tr><td colspan="4">No completed audits yet.</td></tr>';
 const w=window.open('','_blank','width=1000,height=800'); if(!w){alert('Please allow pop-ups to print the Auditor Profile.');return;}
 w.document.write(`<!doctype html><html><head><title>${esc(name)} - Auditor Profile</title><style>body{font-family:Arial,sans-serif;color:#111;margin:30px}h1{font-size:22px;margin-bottom:4px}.muted{color:#64748b;font-size:12px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.card{border:1px solid #bbb;padding:14px}.num{font-size:24px;font-weight:bold;margin-top:6px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #aaa;padding:8px;text-align:left}th{background:#eee}.toolbar{margin-bottom:15px}@media print{.toolbar{display:none}body{margin:12mm}}</style></head><body><div class="toolbar"><button onclick="window.print()">PRINT / SAVE AS PDF</button></div><h1>${esc(name)} — Auditor Profile</h1><p class="muted">Statistics based on audits assigned to this auditor.</p><div class="cards"><div class="card"><b>Assigned Audits</b><div class="num">${all.length}</div></div><div class="card"><b>Completed</b><div class="num">${completed.length}</div></div><div class="card"><b>Pass Rate</b><div class="num">${passPct}%</div></div><div class="card"><b>Avg Completion</b><div class="num">${avg} hrs</div></div><div class="card"><b>Measurements</b><div class="num">${meas}</div></div><div class="card"><b>OOT Measurements</b><div class="num">${oot}</div></div><div class="card"><b>Major Defects</b><div class="num">${major}</div></div><div class="card"><b>Minor Defects</b><div class="num">${minor}</div></div></div><h2>Performance by Garment Type</h2><table><thead><tr><th>Garment Type</th><th>Completed</th><th>Pass Rate</th><th>Avg Completion</th></tr></thead><tbody>${typeRows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`);w.document.close();
}
function shipmentNumbers(a){
 const set=new Set();
 a.forEach(x=>{const n=String(x.shipmentNumber||'').trim();if(n)set.add(n);});
 return [...set].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
}
function shipmentSummary(a,shipmentNumber){
 const number=String(shipmentNumber||'').trim();
 if(!number)return null;
 const rows=a.filter(x=>String(x.shipmentNumber||'').trim()===number);
 if(!rows.length)return null;
 const first=rows.map(x=>x.shipmentQueueAt||x.ready).filter(Boolean).sort((u,v)=>new Date(u)-new Date(v))[0]||null;
 const allCompleted=rows.length>0 && rows.every(x=>x.status==='Completed'&&x.complete);
 const completedAt=allCompleted ? rows.map(x=>x.complete).sort((u,v)=>new Date(v)-new Date(u))[0] : null;
 const totalHrs=first&&completedAt ? ((new Date(completedAt)-new Date(first))/36e5) : null;
 return {number,rows,first,completedAt,totalHrs,allCompleted};
}

function dashboardDateMatch(x,start,end){
 const raw=x.status==='Completed'?x.complete:(x.status==='Available'?x.ready:x.start);
 if(!raw)return false;
 const d=new Date(raw); if(Number.isNaN(d.getTime()))return false;
 if(start){const sd=new Date(start+'T00:00:00'); if(d<sd)return false;}
 if(end){const ed=new Date(end+'T23:59:59.999'); if(d>ed)return false;}
 return true;
}
function dashboardFilter(a){
 const start=document.getElementById('dashStartDate')?.value||'';
 const end=document.getElementById('dashEndDate')?.value||'';
 if(start&&end&&start>end)return {rows:a,invalid:true,start,end};
 if(!start&&!end)return {rows:a,invalid:false,start,end};
 return {rows:a.filter(x=>dashboardDateMatch(x,start,end)),invalid:false,start,end};
}
function dashboard(a){
 if(db.user!=='Manager')return `<h2>Dashboard</h2><p class="muted">Dashboard data is available to the Manager only.</p>`;
 const selected=dashboardFilter(a);
 if(selected.invalid)return `<div class="auditrow dashboard-heading"><div><h2>Dashboard</h2><p class="muted">Please choose a valid date range.</p></div></div><div class="section"><label>From <input type="date" id="dashStartDate" value="${esc(selected.start)}"></label><label>To <input type="date" id="dashEndDate" value="${esc(selected.end)}"></label><button id="clearDashDates">CLEAR DATES</button></div>`;
 const rows=selected.rows;
 let av=rows.filter(x=>x.status==='Available').length,ip=rows.filter(x=>x.status==='In Progress').length,c=rows.filter(x=>x.status==='Completed'),passed=c.filter(x=>String(x.result||'').toUpperCase()==='PASS').length,passPct=c.length?(passed/c.length*100).toFixed(1):'0.0';
 let tat=c.filter(x=>x.start&&x.complete).map(x=>(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5);let avg=tat.length?(tat.reduce((p,n)=>p+n,0)/tat.length).toFixed(2):'0';
 const groups={}; c.filter(x=>x.start&&x.complete&&x.assigned).forEach(x=>{const auditor=x.assigned||'Unassigned',garmentType=x.garmentTypeName||x.garmentType||'Unspecified';const key=auditor+'\u0000'+garmentType;const hrs=(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5;if(!groups[key])groups[key]={auditor,garmentType,count:0,total:0};groups[key].count++;groups[key].total+=hrs;});
 const tatAuditors=[...new Set(Object.values(groups).map(g=>g.auditor))].sort((a,b)=>a.localeCompare(b)); if(dashboardTatAuditorSelection && !tatAuditors.includes(dashboardTatAuditorSelection))dashboardTatAuditorSelection='';
 const tatFiltered=Object.values(groups).filter(g=>!dashboardTatAuditorSelection||g.auditor===dashboardTatAuditorSelection).sort((u,v)=>u.auditor.localeCompare(v.auditor)||u.garmentType.localeCompare(v.garmentType));
 const tatRows=tatFiltered.map(g=>`<tr><td>${esc(g.auditor)}</td><td>${esc(g.garmentType)}</td><td>${g.count}</td><td>${(g.total/g.count).toFixed(2)} hrs</td></tr>`).join('')||'<tr><td colspan="4">No completed audits with timing data for the selected auditor.</td></tr>';
 const suppliers={}; c.forEach(x=>{const supplier=String(x.supplier||'Unspecified').trim()||'Unspecified';if(!suppliers[supplier])suppliers[supplier]={supplier,total:0,passed:0};suppliers[supplier].total++;if(String(x.result||'').toUpperCase()==='PASS')suppliers[supplier].passed++;});
 const supplierRows=Object.values(suppliers).sort((u,v)=>u.supplier.localeCompare(v.supplier)).map(g=>`<tr><td>${esc(g.supplier)}</td><td>${g.total}</td><td>${g.passed}</td><td>${(g.passed/g.total*100).toFixed(1)}%</td></tr>`).join('')||'<tr><td colspan="4">No completed POs in the selected date range.</td></tr>';
 const shipments=shipmentNumbers(rows); if(dashboardShipmentSelection && !shipments.includes(dashboardShipmentSelection))dashboardShipmentSelection='';
 const ss=shipmentSummary(a,dashboardShipmentSelection);
 const shipmentRows=ss ? `<div class="shipment-detail-grid"><div><b>Shipment #</b><span>${esc(ss.number)}</span></div><div><b>First PO Entered Queue</b><span>${dt(ss.first)}</span></div><div><b>All POs Completed</b><span>${ss.completedAt?dt(ss.completedAt):'Not completed'}</span></div><div><b>Total Shipment Completion Time</b><span>${ss.totalHrs===null?'—':ss.totalHrs.toFixed(2)+' hrs'}</span></div><div><b>POs in Shipment</b><span>${ss.rows.length}</span></div><div><b>Completed POs</b><span>${ss.rows.filter(x=>x.status==='Completed').length} / ${ss.rows.length}</span></div></div><div class="shipment-po-list"><h4>PO Numbers in Shipment</h4><div class="tablewrap"><table><thead><tr><th>Shipment PO</th><th>PO Number</th><th>Status</th></tr></thead><tbody>${ss.rows.slice().sort((a,b)=>(Number(a.shipmentSeq)||0)-(Number(b.shipmentSeq)||0)).map((x,i)=>`<tr><td>${x.shipmentSeq&&x.shipmentTotal?esc(`${x.shipmentSeq}/${x.shipmentTotal}`):esc(i+1)}</td><td><b>${esc(x.po)}</b></td><td>${esc(x.status||'—')}</td></tr>`).join('')||'<tr><td colspan="3">No POs found in this shipment.</td></tr>'}</tbody></table></div></div>`:'<p class="muted">Select a shipment number to view shipment details and PO numbers.</p>';
 return `<div class="auditrow dashboard-heading"><div><h2>Dashboard</h2><p class="muted">Manager dashboard statistics and auditor performance.</p></div><button type="button" class="primary" id="printDashboardStats">PRINT DASHBOARD DATA</button></div>
 <div class="section dashboard-filters"><div class="auditrow"><div><h3>Date Range</h3><p class="muted">Completed PO statistics use the PO completion date. Active/open counts use their start/ready date.</p></div><div><label>From <input type="date" id="dashStartDate" value="${esc(selected.start)}"></label><label>To <input type="date" id="dashEndDate" value="${esc(selected.end)}"></label><button type="button" id="clearDashDates">CLEAR DATES</button></div></div></div>
 <div class="cards"><div class="card">Available<div class="num">${av}</div></div><div class="card">In Progress<div class="num">${ip}</div></div><div class="card">Completed<div class="num">${c.length}</div></div><div class="card">PO Pass Rate<div class="num">${passPct}%</div><div class="muted small">${passed} of ${c.length} completed POs</div></div><div class="card">Urgent Open<div class="num">${rows.filter(x=>x.status!=='Completed'&&x.priority==='Urgent').length}</div></div><div class="card">Avg TAT (hrs)<div class="num">${avg}</div></div></div>
 <div class="section"><h3>Shipments</h3><div class="grid"><label>Shipment Number<select id="shipmentDashboardSelect"><option value="">Select shipment…</option>${shipments.map(n=>`<option value="${esc(n)}" ${dashboardShipmentSelection===n?'selected':''}>${esc(n)}</option>`).join('')}</select></label></div>${shipmentRows}</div>
 <div class="section"><h3>Auditor Workload</h3><div class="tablewrap"><table><thead><tr><th>Auditor</th><th>Active Audits</th><th></th></tr></thead><tbody>${db.auditors.map(n=>`<tr><td><b>${esc(n)}</b></td><td>${rows.filter(x=>x.status==='In Progress'&&x.assigned===n).length}</td><td><button type="button" data-profile="${esc(n)}">VIEW PROFILE</button></td></tr>`).join('')}</tbody></table></div></div>
 <div class="section"><div class="auditrow"><div><h3>Average Completion Time by Auditor &amp; Garment Type</h3><p class="muted">Uses completed audit time from start to completion, excluding paused time.</p></div><label>View Auditor<select id="tatAuditorSelect"><option value="">All Auditors</option>${tatAuditors.map(n=>`<option value="${esc(n)}" ${dashboardTatAuditorSelection===n?'selected':''}>${esc(n)}</option>`).join('')}</select></label></div><div class="tablewrap"><table><thead><tr><th>Auditor</th><th>Garment Type</th><th>Completed Audits</th><th>Average Completion Time</th></tr></thead><tbody>${tatRows}</tbody></table></div></div>
 <div class="section"><h3>PO Pass Rate by Supplier</h3><p class="muted">Percentage of completed POs that passed for each supplier in the selected date range.</p><div class="tablewrap"><table><thead><tr><th>Supplier</th><th>Completed POs</th><th>Passed POs</th><th>PO Pass Rate</th></tr></thead><tbody>${supplierRows}</tbody></table></div></div>`;
}
function printDashboardStats(){
 const selected=dashboardFilter(db.audits); if(selected.invalid){alert('Please choose a valid date range.');return;}
 const rows=selected.rows,c=rows.filter(x=>x.status==='Completed'),passed=c.filter(x=>String(x.result||'').toUpperCase()==='PASS').length,passPct=c.length?(passed/c.length*100).toFixed(1):'0.0';
 const tat=c.filter(x=>x.start&&x.complete).map(x=>(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5),avg=tat.length?(tat.reduce((p,n)=>p+n,0)/tat.length).toFixed(2):'0.00';
 const groups={};c.filter(x=>x.start&&x.complete&&x.assigned).forEach(x=>{const k=x.assigned+'\u0000'+(x.garmentTypeName||x.garmentType||'Unspecified');if(!groups[k])groups[k]={auditor:x.assigned,garmentType:x.garmentTypeName||x.garmentType||'Unspecified',count:0,total:0};groups[k].count++;groups[k].total+=(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5;});
 const suppliers={};c.forEach(x=>{const supplier=String(x.supplier||'Unspecified').trim()||'Unspecified';if(!suppliers[supplier])suppliers[supplier]={supplier,total:0,passed:0};suppliers[supplier].total++;if(String(x.result||'').toUpperCase()==='PASS')suppliers[supplier].passed++;});
 const options=[['completed','Completed POs'],['passRate','PO Pass Rate'],['tat','Avg TAT (hrs)'],['supplier','PO Pass Rate by Supplier'],['auditor','Auditor Workload'],['garment','Avg Completion by Auditor & Garment Type']];
 const modal=document.getElementById('modal');if(!modal)return;
 modal.className='modalbox';modal.innerHTML=`<div class="modalcontent"><div class="auditrow"><div><h2>Select Dashboard Data to Print</h2><p class="muted">Choose which dashboard sections to include. The selected date range will be shown on the printout.</p></div><button type="button" id="closeDashPrint">CLOSE</button></div><div class="section"><label>From <input type="date" id="printDashStart" value="${esc(selected.start)}"></label><label>To <input type="date" id="printDashEnd" value="${esc(selected.end)}"></label></div><div class="section"><div class="dashboard-print-options">${options.map(([v,l],i)=>`<label><input type="checkbox" class="dashPrintOpt" value="${v}" ${i<3?'checked':''}> ${l}</label>`).join('')}</div></div><div class="toolbar"><button class="primary" id="doPrintDashboard">PRINT SELECTED</button></div></div>`;
 document.getElementById('closeDashPrint').onclick=closeModal;
 document.getElementById('doPrintDashboard').onclick=()=>{const chosen=[...document.querySelectorAll('.dashPrintOpt:checked')].map(x=>x.value);if(!chosen.length){alert('Select at least one dashboard section to print.');return;}const ps=document.getElementById('printDashStart')?.value||'';const pe=document.getElementById('printDashEnd')?.value||'';if(ps&&pe&&ps>pe){alert('Please choose a valid date range.');return;}closeModal();printDashboardSections(chosen,ps,pe);};
}
function printDashboardSections(chosen,start,end){
 const rows=db.audits.filter(x=>dashboardDateMatch(x,start,end)),c=rows.filter(x=>x.status==='Completed'),passed=c.filter(x=>String(x.result||'').toUpperCase()==='PASS').length,passPct=c.length?(passed/c.length*100).toFixed(1):'0.0';
 const tat=c.filter(x=>x.start&&x.complete).map(x=>(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5),avg=tat.length?(tat.reduce((p,n)=>p+n,0)/tat.length).toFixed(2):'0.00';
 const suppliers={};c.forEach(x=>{const supplier=String(x.supplier||'Unspecified').trim()||'Unspecified';if(!suppliers[supplier])suppliers[supplier]={supplier,total:0,passed:0};suppliers[supplier].total++;if(String(x.result||'').toUpperCase()==='PASS')suppliers[supplier].passed++;});
 const groups={};c.filter(x=>x.start&&x.complete&&x.assigned).forEach(x=>{const k=x.assigned+'\u0000'+(x.garmentTypeName||x.garmentType||'Unspecified');if(!groups[k])groups[k]={auditor:x.assigned,garmentType:x.garmentTypeName||x.garmentType||'Unspecified',count:0,total:0};groups[k].count++;groups[k].total+=(new Date(x.complete)-new Date(x.start)-(Number(x.pausedMs)||0))/36e5;});
 const range=(start||end)?`${start||'Beginning'} to ${end||'Present'}`:'All dates';
 let body=`<h1>DC Quality Audit Dashboard</h1><p>Selected date range: ${esc(range)}</p>`;
 if(chosen.includes('completed'))body+=`<section><h2>Completed POs</h2><div class="value">${c.length}</div></section>`;
 if(chosen.includes('passRate'))body+=`<section><h2>PO Pass Rate</h2><div class="value">${passPct}%</div><p>${passed} of ${c.length} completed POs passed.</p></section>`;
 if(chosen.includes('tat'))body+=`<section><h2>Avg TAT (hrs)</h2><div class="value">${avg}</div></section>`;
 if(chosen.includes('supplier'))body+=`<section><h2>PO Pass Rate by Supplier</h2><table><thead><tr><th>Supplier</th><th>Completed POs</th><th>Passed POs</th><th>PO Pass Rate</th></tr></thead><tbody>${Object.values(suppliers).sort((a,b)=>a.supplier.localeCompare(b.supplier)).map(g=>`<tr><td>${esc(g.supplier)}</td><td>${g.total}</td><td>${g.passed}</td><td>${(g.passed/g.total*100).toFixed(1)}%</td></tr>`).join('')||'<tr><td colspan="4">No completed POs.</td></tr>'}</tbody></table></section>`;
 if(chosen.includes('auditor'))body+=`<section><h2>Auditor Workload</h2><table><thead><tr><th>Auditor</th><th>Active Audits</th></tr></thead><tbody>${db.auditors.map(n=>`<tr><td>${esc(n)}</td><td>${rows.filter(x=>x.status==='In Progress'&&x.assigned===n).length}</td></tr>`).join('')}</tbody></table></section>`;
 if(chosen.includes('garment'))body+=`<section><h2>Average Completion by Auditor &amp; Garment Type</h2><table><thead><tr><th>Auditor</th><th>Garment Type</th><th>Completed Audits</th><th>Average Completion</th></tr></thead><tbody>${Object.values(groups).sort((a,b)=>a.auditor.localeCompare(b.auditor)||a.garmentType.localeCompare(b.garmentType)).map(g=>`<tr><td>${esc(g.auditor)}</td><td>${esc(g.garmentType)}</td><td>${g.count}</td><td>${(g.total/g.count).toFixed(2)} hrs</td></tr>`).join('')||'<tr><td colspan="4">No completed audits with timing data.</td></tr>'}</tbody></table></section>`;
 const w=window.open('','_blank','width=1000,height=800');if(!w){alert('Please allow pop-ups to print Dashboard data.');return;}w.document.write(`<!doctype html><html><head><title>Dashboard Data</title><style>body{font-family:Arial,sans-serif;color:#111;margin:30px}h1{font-size:24px}.value{font-size:32px;font-weight:bold;margin:10px 0 20px}section{margin:0 0 24px;page-break-inside:avoid}table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:8px;text-align:left}th{background:#eee}.toolbar{margin-bottom:20px}@media print{body{margin:12mm}.toolbar{display:none}}</style></head><body><div class="toolbar"><button onclick="window.print()">PRINT / SAVE AS PDF</button><button onclick="window.close()">CLOSE</button></div>${body}<script>window.onload=()=>setTimeout(()=>window.print(),250);</script></body></html>`);w.document.close();
}
function add(){
 let rows=Array.from({length:30},(_,i)=>`<tr data-batch-row="${i}"><td>${i+1}</td><td><input name="po${i}"></td><td><input name="style${i}"></td><td><input name="supplier${i}" list="supplierList" placeholder="Supplier"></td><td><input name="qty${i}" type="number"></td><td><input name="aql${i}"></td><td><select name="priority${i}"><option>Normal</option><option>Priority</option><option>Urgent</option></select></td></tr>`).join('');
 return `<div class="auditrow"><div><h2>Add Audits</h2><p class="muted">Enter up to 30 POs at once. If the shipment has more than 30 POs, use <b>+ ADD ADDITIONAL PO</b> to add more rows before submitting. Each entered PO is automatically assigned its shipment position (for example, 1/35, 2/35).</p></div><button type="button" id="clearBatch">CLEAR</button></div><form id="batchform"><div class="section"><div class="grid"><div><label>Shipment Number *<input name="shipmentNumber" required placeholder="e.g. SHP-2026-001"></label></div><div><label>POs currently shown <input id="batchRowCount" value="30" readonly></label></div></div></div><div class="tablewrap"><table class="batchtable"><thead><tr><th>#</th><th>PO # *</th><th>Style</th><th>Supplier</th><th>Qty</th><th>AQL Sample</th><th>Priority</th></tr></thead><tbody id="batchRows">${rows}</tbody></table></div><datalist id="supplierList">${db.suppliers.map(sp=>`<option value="${esc(sp.name)}">`).join('')}</datalist><div class="toolbar"><button type="button" id="addAdditionalPO">+ ADD ADDITIONAL PO</button></div><div class="section"><label>Common notes (optional)<textarea name="commonNotes" placeholder="Applies to all entered POs"></textarea></label></div><button class="primary" type="submit">ADD ENTERED POs TO QUEUE</button></form>`}

function bind(){
 const cs=document.getElementById('connectSharedFolder'); if(cs) cs.onclick=connectSharedFolder;
 const ss=document.getElementById('testSharedFolder'); if(ss) ss.onclick=async()=>{await pollShared();alert(sharedDirHandle?'Shared data synchronized.':'No shared folder is connected.');};
 const disconnectShared=document.getElementById('disconnectSharedFolder'); if(disconnectShared) disconnectShared.onclick=disconnectSharedFolder;

 document.querySelectorAll('[data-take]').forEach(b=>b.onclick=()=>{let x=db.audits.find(x=>x.id==b.dataset.take);if(x){x.status='In Progress';x.assigned=db.user;x.start=x.start||new Date().toISOString();x.pausedMs=Number(x.pausedMs)||0;x.pauseStarted=null;x.pauseHistory=Array.isArray(x.pauseHistory)?x.pauseHistory:[];save();render()}});
 document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openAudit(b.dataset.open));
 document.querySelectorAll('[data-profile]').forEach(b=>b.onclick=()=>showAuditorProfile(b.dataset.profile));
 const pds=document.getElementById('printDashboardStats'); if(pds) pds.onclick=()=>printDashboardStats();
 const sr=document.getElementById('supplierReportSelect');if(sr)sr.onchange=()=>{supplierReportSelection=sr.value;render()};const srs=document.getElementById('supplierStartDate'),sre=document.getElementById('supplierEndDate');if(srs)srs.onchange=()=>render();if(sre)sre.onchange=()=>render();const src=document.getElementById('clearSupplierDates');if(src)src.onclick=()=>{if(srs)srs.value='';if(sre)sre.value='';render()};const psr=document.getElementById('printSupplierReport');if(psr)psr.onclick=()=>printSupplierReport();
 const ds=document.getElementById('dashStartDate'),de=document.getElementById('dashEndDate');
 if(ds) ds.onchange=()=>render(); if(de) de.onchange=()=>render();
 const cd=document.getElementById('clearDashDates'); if(cd) cd.onclick=()=>{if(ds)ds.value='';if(de)de.value='';render();};
 document.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>{const x=db.audits.find(a=>a.id===b.dataset.resume);if(!x)return;const now=new Date();x.pauseHistory=Array.isArray(x.pauseHistory)?x.pauseHistory:[];if(x.pauseStarted){const start=new Date(x.pauseStarted);const elapsed=Math.max(0,now-start);x.pausedMs=(Number(x.pausedMs)||0)+elapsed;x.pauseHistory.push({start:x.pauseStarted,end:now.toISOString(),durationMs:elapsed});}x.pauseStarted=null;x.status='In Progress';x.resumedAt=now.toISOString();save();openAudit(x.id);});
 document.querySelectorAll('[data-print]').forEach(b=>b.onclick=()=>printReports([b.dataset.print]));
 document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openAudit(b.dataset.edit,true));
 document.querySelectorAll('[data-delete-audit]').forEach(b=>b.onclick=()=>{if(db.user!=='Manager')return;const x=db.audits.find(a=>a.id===b.dataset.deleteAudit);if(!x)return;if(confirm(`Delete audit \"${x.po}\" from history? This cannot be undone.`)){db.audits=db.audits.filter(a=>a.id!==x.id);save();render();}});
 const hs=document.getElementById('historySearch'); if(hs) hs.oninput=()=>{const q=hs.value.trim().toLowerCase();const rows=visibleAudits(db.audits).filter(x=>x.status==='Completed').sort((a,b)=>new Date(b.complete)-new Date(a.complete)).filter(x=>String(x.po||'').toLowerCase().includes(q));const body=document.getElementById('historyBody');if(body)body.innerHTML=historyRows(rows);bind();};
 const hc=document.getElementById('clearHistorySearch'); if(hc) hc.onclick=()=>{if(hs){hs.value='';hs.oninput();}};
 const sa=document.getElementById('selectAll'); if(sa) sa.onchange=()=>document.querySelectorAll('.reportSelect').forEach(c=>c.checked=sa.checked);
 const ps=document.getElementById('printSelected'); if(ps) ps.onclick=()=>{let ids=[...document.querySelectorAll('.reportSelect:checked')].map(c=>c.value);if(!ids.length){alert('Select at least one completed audit.');return}printReports(ids)};
 const pa=document.getElementById('printAll'); if(pa) pa.onclick=()=>{let ids=visibleAudits(db.audits).filter(x=>x.status==='Completed').map(x=>x.id);if(ids.length)printReports(ids);else alert('There are no completed audits to print.')};
 const refreshManagerQueue=document.getElementById('refreshManagerQueue'); if(refreshManagerQueue) refreshManagerQueue.onclick=()=>render();
 const af=document.getElementById('auditorForm'); if(af) af.onsubmit=async e=>{e.preventDefault(); if(db.user!=='Manager')return; const rows=[...af.querySelectorAll('#auditorRows tr')]; const records=[]; const usernames=new Set(); for(const row of rows){ const name=row.querySelector('.auditor-name')?.value.trim()||''; const username=row.querySelector('.auditor-username')?.value.trim()||''; const password=row.querySelector('.auditor-password')?.value||''; const title=row.querySelector('.auditor-title')?.value.trim()||'Auditor'; const original=row.querySelector('.auditor-name')?.dataset.original||''; if(!name||!username||!title){alert('Every auditor must have a name, title, and username.');return;} const key=username.toLowerCase(); if(usernames.has(key)){alert('Auditor usernames must be unique.');return;} usernames.add(key); const oldAcc=db.auditorAccounts.find(a=>a.name===original); records.push({id:oldAcc?.id||crypto.randomUUID(),name,title,username,passwordHash:password?await hashPassword(password):(oldAcc?.passwordHash||null)}); } if(!records.length){alert('At least one auditor is required.');return} const names=records.map(r=>r.name);if(new Set(names.map(n=>n.toLowerCase())).size!==names.length){alert('Auditor names must be unique.');return;} const mapping=new Map(rows.map(row=>[row.querySelector('.auditor-name')?.dataset.original||'',row.querySelector('.auditor-name')?.value.trim()||''])); db.audits.forEach(a=>{if(a.assigned && mapping.has(a.assigned)) a.assigned=mapping.get(a.assigned);}); db.auditors=names;db.auditorAccounts=records;save();render();alert('Auditor accounts saved.');};
 const addAuditor=document.getElementById('addAuditor'); if(addAuditor) addAuditor.onclick=()=>{ if(db.user!=='Manager')return; const tbody=document.getElementById('auditorRows'); const n=tbody?.querySelectorAll('tr').length||0; const tr=document.createElement('tr'); tr.innerHTML=`<td>${n+1}</td><td><input class="auditor-name" data-original="" value="" placeholder="Auditor name" required></td><td><input class="auditor-title" value="Auditor" placeholder="e.g. Lead Auditor" required></td><td><input class="auditor-username" value="" placeholder="username" required></td><td><input class="auditor-password" type="password" value="" placeholder="Set / change password"></td><td><button type="button" class="danger remove-auditor">REMOVE</button></td>`; tbody?.appendChild(tr);};
 document.querySelectorAll('.remove-auditor').forEach(b=>b.onclick=()=>{if(db.user!=='Manager')return; const rows=document.querySelectorAll('#auditorRows tr'); if(rows.length<=1){alert('At least one auditor is required.');return;} const row=b.closest('tr'); const name=row?.querySelector('.auditor-name')?.value.trim(); if(name && db.audits.some(a=>a.status!=='Completed' && a.assigned===name)){alert('This auditor has an active audit. Reassign or complete that audit before removing the auditor.');return;} row?.remove(); [...document.querySelectorAll('#auditorRows tr')].forEach((r,i)=>r.children[0].textContent=i+1);});
 const maf=document.getElementById('managerAccountForm'); if(maf) maf.onsubmit=async e=>{e.preventDefault();if(db.user!=='Manager')return;const username=document.getElementById('managerUsername').value.trim();const password=document.getElementById('managerPassword').value;if(!username){alert('Manager username is required.');return;}if(db.auditorAccounts.some(a=>String(a.username||'').toLowerCase()===username.toLowerCase())){alert('Manager username must be different from every auditor username.');return;}db.managerAccount.username=username;if(password)db.managerAccount.passwordHash=await hashPassword(password);save();alert('Manager login saved.');};
 const sf=document.getElementById('supplierForm'); if(sf) sf.onsubmit=e=>{e.preventDefault(); if(db.user!=='Manager')return; const rows=[...sf.querySelectorAll('#supplierRows tr')]; const vals=rows.map(r=>({name:r.querySelector('.supplier-name')?.value.trim()||'',coo:r.querySelector('.supplier-coo')?.value.trim()||''})); if(vals.some(v=>!v.name||!v.coo)){alert('Supplier and COO are required.');return;} if(new Set(vals.map(v=>v.name.toLowerCase())).size!==vals.length){alert('Supplier names must be unique.');return;} db.suppliers=vals; db.audits.forEach(a=>{const match=vals.find(v=>v.name.toLowerCase()===String(a.supplier||'').toLowerCase()); if(match){a.supplier=match.name;a.coo=match.coo;}}); save(); render(); alert('Supplier changes saved.');};
 const addSupplier=document.getElementById('addSupplier'); if(addSupplier) addSupplier.onclick=()=>{const tbody=document.getElementById('supplierRows'); const n=tbody?.querySelectorAll('tr').length||0; const tr=document.createElement('tr'); tr.innerHTML=`<td>${n+1}</td><td><input class="supplier-name" data-original="" value="" placeholder="Supplier name" required></td><td><input class="supplier-coo" value="" placeholder="Country of origin" required></td><td><button type="button" class="danger remove-supplier">REMOVE</button></td>`; tbody?.appendChild(tr);};
 document.querySelectorAll('.remove-supplier').forEach(b=>b.onclick=()=>{b.closest('tr')?.remove();[...document.querySelectorAll('#supplierRows tr')].forEach((r,i)=>r.children[0].textContent=i+1);});
 const df=document.getElementById('defectForm'); if(df) df.onsubmit=e=>{e.preventDefault();if(db.user!=='Manager')return;const vals=[...df.querySelectorAll('.defect-option-name')].map(i=>i.value.trim()).filter(Boolean);if(new Set(vals.map(v=>v.toLowerCase())).size!==vals.length){alert('Defect names must be unique.');return;}db.defectOptions=vals;save();render();alert('Defect list saved.');};
 const addDefectOption=document.getElementById('addDefectOption'); if(addDefectOption) addDefectOption.onclick=()=>{const tbody=document.getElementById('defectRows');if(!tbody)return;if(tbody.querySelector('td[colspan]'))tbody.innerHTML='';const n=tbody.querySelectorAll('tr').length;const tr=document.createElement('tr');tr.innerHTML=`<td>${n+1}</td><td><input class="defect-option-name" value="" placeholder="e.g. Broken stitch" required></td><td><button type="button" class="danger remove-defect-option">REMOVE</button></td>`;tbody.appendChild(tr);tr.querySelector('input')?.focus();bindManagerDefectRows();};
 bindManagerDefectRows();
 bindTemplateEditor();
 document.querySelectorAll('[data-delete-template]').forEach(b=>b.onclick=()=>{if(db.user!=='Manager')return; const t=db.garmentTemplates.find(t=>t.id===b.dataset.deleteTemplate); if(t&&confirm(`Delete template \"${t.name}\"? Existing audits are not changed.`)){db.garmentTemplates=db.garmentTemplates.filter(x=>x.id!==t.id);save();render();}});
 document.querySelectorAll('[data-edit-template]').forEach(b=>b.onclick=()=>editTemplateForm(b.dataset.editTemplate));
 let f=document.getElementById('batchform');
 if(f) f.onsubmit=e=>{e.preventDefault();let d=Object.fromEntries(new FormData(f));const shipmentNumber=String(d.shipmentNumber||'').trim();if(!shipmentNumber){alert('Enter a shipment number.');return;}const entries=[];[...f.querySelectorAll('#batchRows tr')].forEach(row=>{const i=row.dataset.batchRow;const po=(d[`po${i}`]||'').trim();if(po)entries.push({i,po});});if(!entries.length){alert('Enter at least one PO number.');return}const now=new Date().toISOString();const existing=db.audits.filter(x=>String(x.shipmentNumber||'').trim()===shipmentNumber);const existingTotal=existing.length;const total=existingTotal+entries.length;entries.forEach((entry,j)=>{const supplierName=d[`supplier${entry.i}`]||'';const supplierMatch=db.suppliers.find(sp=>String(sp.name||'').trim().toLowerCase()===String(supplierName).trim().toLowerCase());const seq=existingTotal+j+1;db.audits.push({id:crypto.randomUUID(),po:entry.po,style:d[`style${entry.i}`]||'',supplier:supplierName,coo:supplierMatch?.coo||'',qty:d[`qty${entry.i}`]||'',aql:d[`aql${entry.i}`]||'',priority:d[`priority${entry.i}`]||'Normal',notes:d.commonNotes||'',sizeRange:'',sizesInspected:'',color:'',description:'',shipmentNumber,shipmentSeq:seq,shipmentTotal:total,shipmentQueueAt:now,status:'Available',ready:now});});if(existing.length)existing.forEach(x=>{x.shipmentTotal=total;});save();alert(`${entries.length} audit${entries.length===1?'':'s'} added to shipment ${shipmentNumber} (${existingTotal+1}/${total} through ${total}/${total}).`);view='queue';render()};
 const addAdditionalPO=document.getElementById('addAdditionalPO'); if(addAdditionalPO) addAdditionalPO.onclick=()=>{const tbody=document.getElementById('batchRows');if(!tbody)return;const n=tbody.querySelectorAll('tr').length;const tr=document.createElement('tr');tr.dataset.batchRow=n;tr.innerHTML=`<td>${n+1}</td><td><input name="po${n}"></td><td><input name="style${n}"></td><td><input name="supplier${n}" list="supplierList" placeholder="Supplier"></td><td><input name="qty${n}" type="number"></td><td><input name="aql${n}"></td><td><select name="priority${n}"><option>Normal</option><option>Priority</option><option>Urgent</option></select></td>`;tbody.appendChild(tr);const count=document.getElementById('batchRowCount');if(count)count.value=String(n+1);tr.querySelector(`input[name="po${n}"]`)?.focus();};
 const shipSel=document.getElementById('shipmentDashboardSelect'); if(shipSel) shipSel.onchange=e=>{dashboardShipmentSelection=e.target.value||'';render();};
 const tatSel=document.getElementById('tatAuditorSelect'); if(tatSel) tatSel.onchange=e=>{dashboardTatAuditorSelection=e.target.value||'';render();};
 const cb=document.getElementById('clearBatch');if(cb)cb.onclick=()=>{document.getElementById('batchform').reset()};
}
async function saveAuditFormState(x,form){
 let d=Object.fromEntries(new FormData(form));
 const n=Math.max(1,parseInt(d.sample||1,10)||1);
 x.po=d.po; x.style=d.style; x.supplier=d.supplier; x.shipmentNumber=x.shipmentNumber||''; x.shipmentSeq=Number(x.shipmentSeq)||0; x.shipmentTotal=Number(x.shipmentTotal)||0; const gt=document.getElementById('garmentType')?.value||x.garmentTypeId||''; const gtObj=db.garmentTemplates.find(t=>t.id===gt); x.garmentTypeId=gt; x.garmentTypeName=gtObj?.name||x.garmentTypeName||''; x.sample=d.sample; x.aql=d.sample; x.sizeRange=d.sizeRange; x.sizesInspected=d.sizesInspected; x.color=d.color; x.coo=d.coo; x.description=d.description; x.defects=d.defects; x.reinspect=d.reinspect; x.notes=d.notes;
 const sections=collectSizeSections();
 x.measurementSections=sections.map(s=>({size:s.size,count:s.count,rows:s.rows}));
 x.measurementRows=sections.flatMap(s=>s.rows.map(r=>({pom:r.pom,size:s.size,spec:r.spec,tolMinus:r.tolMinus,tolPlus:r.tolPlus,values:r.values.slice(0,s.count)})));
 x.measurementSizes=sections.flatMap(s=>Array(s.count).fill(s.size));
 x.photos=await collectPhotoData();
 x.defectPhotos=await collectDefectPhotoData();
 x.defects=x.defectPhotos.filter(d=>d && (d.image || String(d.label||'').trim())).length;
 x.updatedAt=Date.now();
 return n;
}

function openAudit(id,isEdit=false){
 let x=db.audits.find(a=>a.id==id); if(!x || !canViewAudit(x)){alert('You do not have access to this audit.');return;}
 window.__activeAuditId=id;
 document.getElementById('modal').className='modalbox';
 const sampleCount=Math.max(1,parseInt(x.aql||x.sample||1,10)||1);
 const existing=x.measurementRows||[];
 const sizeSections=buildSizeSections(x, sampleCount);
 const photos=x.photos||{};
 const defectPhotos=x.defectPhotos||Array.from({length:6},()=>({image:'',label:''}));
 const defectSlotCount=Math.max(6,defectPhotos.length);

 document.getElementById('modal').innerHTML=`<div class="modalcontent"><div class="auditrow"><div><h2>Audit: ${esc(x.po)}</h2><p class="muted">${esc(x.style)} · ${esc(x.supplier)} · ${esc(x.assigned)}</p><p class="muted"><b>Active Audit Time:</b> <span id="liveAuditTimer">${liveDuration(x)}</span> &nbsp; <span>${x.status==='Paused'?'PAUSED':'RUNNING'}</span></p></div><div><button type="button" id="pauseAudit" class="${x.status==='Paused'?'hidden':''}">PAUSE AUDIT</button><button type="button" id="maximizeAudit">MAXIMIZE</button><button type="button" id="returnQueue">SEND BACK TO QUEUE</button><button id="close">CLOSE</button></div></div>
 <form id="auditform">
 <div class="section"><h3>Audit Cover Information</h3><p class="muted">These fields are required for the audit report cover page. PO number, style, and supplier may be edited before saving or completing the audit.</p><div class="grid">
  <div><label>PO Number *<input name="po" required value="${esc(x.po||'')}"></label></div>
  <div><label>Style *<input name="style" required value="${esc(x.style||'')}"></label></div>
  <div><label>Supplier *<input name="supplier" list="auditSupplierList" required value="${esc(x.supplier||'')}"></label><datalist id="auditSupplierList">${db.suppliers.map(sp=>`<option value="${esc(sp.name)}">`).join('')}</datalist></div>
  <div><label>Garment Size Range *<input name="sizeRange" required value="${esc(x.sizeRange||'')}" placeholder="e.g. XS–XXL"></label></div>
  <div><label>Sizes Inspected *<input name="sizesInspected" required value="${esc(x.sizesInspected||'')}" placeholder="e.g. S, M, L, XL"></label></div>
  <div><label>Color *<input name="color" required value="${esc(x.color||'')}" placeholder="e.g. Navy"></label></div>
  <div><label>COO *<input name="coo" required value="${esc(x.coo||'')}" placeholder="Country of origin"></label></div>
  <div class="full"><label>Garment Style Description *<textarea name="description" required placeholder="Describe the garment style">${esc(x.description||'')}</textarea></label></div>
 </div></div>
 <div class="grid">
  <div><label>AQL / Sample Size<input id="sampleSize" name="sample" type="number" min="1" value="${esc(x.aql||x.sample||'')}"></label><p class="muted small">Total garment sample for this audit. Size sections below divide that sample by garment size.</p></div>
  <div><label>Defects Found<input id="defectCount" name="defects" type="number" min="0" value="${esc(x.defects||0)}" readonly></label></div>
  <div><label>Major Defects<input id="majorDefectCount" type="number" min="0" value="0" readonly></label></div>
  <div><label>Minor Defects<input id="minorDefectCount" type="number" min="0" value="0" readonly></label></div>
  <div><label>Max Allowable Major Defects<input id="maxMajorDefects" type="number" min="0" value="${defectAcceptance(x).allowed===null?'':defectAcceptance(x).allowed}" readonly></label></div>
  <div><label>Effective Major Defects<input id="effectiveMajorDefects" type="number" min="0" step="0.01" value="0" readonly></label></div>
  <div><label>Defect Check<input id="defectCheck" type="text" value="${esc(defectAcceptance(x).label)}" readonly></label></div>
  <div><label>Reinspection<select name="reinspect"><option ${(!x.reinspect||x.reinspect==='First Audit')?'selected':''}>First Audit</option><option ${x.reinspect==='Second Audit'?'selected':''}>Second Audit</option></select></label></div>
  <div class="full"><label>Notes<textarea name="notes">${esc(x.notes||'')}</textarea></label></div>
 </div>

 <div class="section"><div class="auditrow"><div><h3>Measurements</h3><p class="muted">Measurements are organized by garment size. Enter each size once as a section heading, then enter the POMs measured for that size. Each size section can contain multiple garments of that size.</p></div><div><label>Garment Type<select id="garmentType"><option value="">Select template…</option>${db.garmentTemplates.map(t=>`<option value="${esc(t.id)}" ${x.garmentTypeId===t.id?"selected":""}>${esc(t.name)}</option>`).join("")}</select></label><button type="button" id="addSizeSection">+ ADD SIZE</button><button type="button" id="addmeasure">+ ADD POM</button></div></div>
 <div id="sizeSections">${sizeSections.map((sec,i)=>renderSizeSection(sec,i,sampleCount)).join('')}</div>
 <p class="muted small">Each size section has its own POM, Tol. -, Tol. +, Spec., and garment measurements. The size is entered only once for the entire section.</p>
 </div>

 <div class="section"><h3>Garment Photos</h3><p class="muted">Add garment documentation photos to the audit. Images are compressed for local browser storage. Add additional photo slots as needed.</p>
 <div id="garmentPhotoGrid" class="photo-grid">
  ${photoSlot('front','Front',photos.front)}
  ${photoSlot('back','Back',photos.back)}
  ${photoSlot('side','Side View',photos.side)}
  ${photoSlot('special1','Special Part 1',photos.special1)}
  ${photoSlot('special2','Special Part 2',photos.special2)}
  ${photoSlot('label1','Label 1',photos.label1)}
  ${photoSlot('label2','Label 2',photos.label2)}
  ${photoSlot('label3','Label 3',photos.label3)}
  ${Object.keys(photos).filter(k=>!['front','back','side','special1','special2','label1','label2','label3'].includes(k)).map((k,i)=>photoSlot(k,photos[k]?.label||`Garment Photo ${i+9}`,photos[k])).join('')}
 </div><button type="button" id="addGarmentPhoto">+ Add Photo</button></div>

 <div class="section"><h3>Defect Photos</h3><p class="muted">Select the defect from the Manager-defined list, then classify it as Major or Minor.</p><div id="defectPhotoGrid" class="defect-grid">${Array.from({length:defectSlotCount},(_,i)=>defectSlot(i,defectPhotos[i]||{})).join('')}</div><button type="button" id="addDefectPhoto">+ Add Photo</button></div>

 <div class="section"><button class="primary">${isEdit?'SAVE CHANGES':'COMPLETE AUDIT'}</button></div>
 </form></div>`;

 document.getElementById('close').onclick=closeModal;
 const auditModal=document.getElementById('modal'); const auditContent=auditModal?.querySelector('.modalcontent');
 document.getElementById('maximizeAudit')?.addEventListener('click',()=>{auditContent?.classList.toggle('audit-maximized');});
 const auditSupplier=document.querySelector('#auditform input[name="supplier"]'); const auditCoo=document.querySelector('#auditform input[name="coo"]'); const fillSupplierCoo=()=>{const name=(auditSupplier?.value||'').trim().toLowerCase();const match=db.suppliers.find(sp=>String(sp.name||'').trim().toLowerCase()===name);if(match&&auditCoo){auditCoo.value=match.coo||'';}}; if(auditSupplier){auditSupplier.addEventListener('change',fillSupplierCoo);auditSupplier.addEventListener('input',()=>{const name=(auditSupplier.value||'').trim().toLowerCase();const match=db.suppliers.find(sp=>String(sp.name||'').trim().toLowerCase()===name);if(match&&auditCoo)auditCoo.value=match.coo||'';});fillSupplierCoo();}
 bindSizeSections();
 document.getElementById('sampleSize').onchange=()=>{
   const n=Math.max(1,Math.min(100,parseInt(document.getElementById('sampleSize').value||1,10)||1));
   const sections=collectSizeSections();
   renderSizeSections(sections,n);
 };
 document.getElementById('addSizeSection').onclick=()=>{
   const sections=collectSizeSections();
   const t=db.garmentTemplates.find(t=>t.id===(document.getElementById('garmentType')?.value||x.garmentTypeId||''));
   const count=1;
   const rows=t?.poms?.length?t.poms.map(p=>({pom:p.pom||'',spec:p.spec||'',tolMinus:p.tolMinus||'',tolPlus:p.tolPlus||'',values:Array(count).fill('')})):[{pom:'',spec:'',tolMinus:'',tolPlus:'',values:['']}];
   sections.push({size:'',count,rows});
   renderSizeSections(sections,sampleCount);
 };
 document.getElementById('addmeasure').onclick=()=>{
   const sections=collectSizeSections();
   if(!sections.length) sections.push({size:'',count:1,rows:[]});
   sections[sections.length-1].rows.push({pom:'',spec:'',tolMinus:'',tolPlus:'',values:Array(sections[sections.length-1].count).fill('')});
   renderSizeSections(sections,sampleCount);
 };
 document.getElementById('garmentType').onchange=()=>{ const id=document.getElementById('garmentType').value; const t=db.garmentTemplates.find(t=>t.id===id); if(!t)return; const sections=collectSizeSections(); const hasData=sections.some(sec=>sec.rows.some(r=>String(r.pom||r.spec||r.tolMinus||r.tolPlus||'').trim()||(r.values||[]).some(v=>String(v).trim()))); if(hasData && !confirm(`Change Garment Type to "${t.name}" and replace the current POM list with the ${t.name} template? Measurements for POMs with the same name will be preserved; other POMs will be removed.`)){document.getElementById('garmentType').value=x.garmentTypeId||'';return;} x.garmentTypeId=t.id; x.garmentTypeName=t.name; const current=sections.length?sections:[{size:'',count:sampleCount,rows:[]}]; current.forEach(sec=>{ const prior=new Map(sec.rows.map(r=>[String(r.pom||'').trim().toLowerCase(),r])); sec.rows=t.poms.map(p=>{const old=prior.get(String(p.pom||'').trim().toLowerCase())||{};return {pom:p.pom||'',spec:p.spec??old.spec??'',tolMinus:p.tolMinus??old.tolMinus??'',tolPlus:p.tolPlus??old.tolPlus??'',values:Array.from({length:sec.count},(_,i)=>(old.values||[])[i]||'')};}); }); renderSizeSections(current,sampleCount); };

 bindPhotoInputs();
 const addGarmentPhoto=document.getElementById('addGarmentPhoto');
 if(addGarmentPhoto) addGarmentPhoto.onclick=()=>{const grid=document.getElementById('garmentPhotoGrid');if(!grid)return;const used=[...grid.querySelectorAll('.photo-input')].map(i=>i.dataset.photo||'');let n=1;while(used.includes(`garmentExtra${n}`))n++;const key=`garmentExtra${n}`;const label=`Garment Photo ${used.length-7}`;grid.insertAdjacentHTML('beforeend',photoSlot(key,label,{}));bindPhotoInputs();};
 const addDefectPhoto=document.getElementById('addDefectPhoto');
 if(addDefectPhoto) addDefectPhoto.onclick=()=>{const grid=document.getElementById('defectPhotoGrid');if(!grid)return;const i=grid.querySelectorAll('.defect-slot').length;grid.insertAdjacentHTML('beforeend',defectSlot(i,{}));bindPhotoInputs();bindDefectFields();};
 const updateDefectCount=()=>{
   let n=0, major=0, minor=0;
   document.querySelectorAll('.defect-label').forEach((el,i)=>{
     const inp=document.querySelector(`.defect-input[data-defect="${i}"]`);
     const type=document.querySelector(`.defect-type[data-defect-type="${i}"]`)?.value||'';
     if(String(el.value||'').trim() || inp?.dataset.data || type){ n++; if(type==='Major')major++; if(type==='Minor')minor++; }
   });
   const dc=document.getElementById('defectCount'); if(dc) dc.value=n;
   const mj=document.getElementById('majorDefectCount'); if(mj) mj.value=major;
   const mn=document.getElementById('minorDefectCount'); if(mn) mn.value=minor;
   const check=defectAcceptance({aql:document.getElementById('sampleSize')?.value||x.aql||x.sample,defectPhotos:[...document.querySelectorAll('.defect-slot')].map(slot=>({type:slot.querySelector('.defect-type')?.value||'',label:slot.querySelector('.defect-label')?.value||'',image:slot.querySelector('.defect-input')?.dataset.data||''}))});
   const mm=document.getElementById('maxMajorDefects'); if(mm) mm.value=check.allowed===null?'':check.allowed;
   const em=document.getElementById('effectiveMajorDefects'); if(em) em.value=check.effective.toFixed(2);
   const dcx=document.getElementById('defectCheck'); if(dcx){dcx.value=check.label; dcx.className=check.pass?'defect-pass':'defect-fail';}
 };
 function bindDefectFields(){document.querySelectorAll('.defect-label,.defect-type').forEach(el=>{el.oninput=updateDefectCount;el.onchange=updateDefectCount;});}
 bindDefectFields();
 document.getElementById('sampleSize')?.addEventListener('input',updateDefectCount);
 updateDefectCount();

 const timerEl=document.getElementById('liveAuditTimer');
 let timerHandle=null;
 if(timerEl && x.status==='In Progress'){ timerHandle=setInterval(()=>{timerEl.textContent=liveDuration(x)},1000); }
 const pauseBtn=document.getElementById('pauseAudit');
 if(pauseBtn) pauseBtn.onclick=async()=>{
   const form=document.getElementById('auditform');
   await saveAuditFormState(x,form);
   x.status='Paused'; x.pauseStarted=new Date().toISOString(); x.pausedMs=Number(x.pausedMs)||0; x.pauseHistory=Array.isArray(x.pauseHistory)?x.pauseHistory:[]; x.lastPaused=x.pauseStarted;
   save(); if(timerHandle)clearInterval(timerHandle); closeModal(); render();
 };

 const returnQueueBtn=document.getElementById('returnQueue');
 if(returnQueueBtn) returnQueueBtn.onclick=async()=>{if(!confirm(`Send audit \"${x.po}\" back to the queue? Your entered audit data will be saved, but the audit timer and pause history will reset for the next auditor.`))return;const form=document.getElementById('auditform');await saveAuditFormState(x,form);x.status='Available';x.assigned='';x.start=null;x.complete=null;x.result='';x.pausedMs=0;x.pauseStarted=null;x.pauseHistory=[];x.ready=new Date().toISOString();x.resumedAt=null;save();if(timerHandle)clearInterval(timerHandle);closeModal();render();};

 document.getElementById('auditform').onsubmit=async e=>{
   e.preventDefault();
   await saveAuditFormState(x,e.target);
   if(!isEdit){
     if(x.pauseStarted){const now=new Date();const start=new Date(x.pauseStarted);const elapsed=Math.max(0,now-start);x.pausedMs=(Number(x.pausedMs)||0)+elapsed;x.pauseHistory=Array.isArray(x.pauseHistory)?x.pauseHistory:[];x.pauseHistory.push({start:x.pauseStarted,end:now.toISOString(),durationMs:elapsed});x.pauseStarted=null;}
     x.status='Completed'; x.complete=new Date().toISOString(); const st=auditPomStats(x); const ds=defectAcceptance(x); x.result=(st.pass && ds.pass)?'PASS':'FAIL';
   } else {x.lastEdited=new Date().toISOString(); const st=auditPomStats(x); const ds=defectAcceptance(x); x.result=(st.pass && ds.pass)?'PASS':'FAIL';}
   save(); closeModal(); render();
 };
}

function photoSlot(key,label,data){
 const d=data||{};
 return `<div class="photo-slot"><div class="photo-title">${esc(label)}</div>
   <div class="photo-preview" id="preview-${key}">${d.image?`<img src="${d.image}" alt="${esc(label)}">`:'<span>No photo</span>'}</div>
   <div class="photo-actions"><input type="file" accept="image/*" class="photo-input" data-photo="${key}" data-photo-label="${esc(label)}"><button type="button" class="download-photo" data-download-photo="${key}" ${d.image?'':'disabled'}>DOWNLOAD</button><button type="button" class="danger remove-photo" data-remove-photo="${key}" ${d.image?'':'disabled'}>REMOVE PHOTO</button></div>
 </div>`;
}
function defectSlot(i,data){
 const d=data||{}; const type=d.type||''; const current=String(d.label||'').trim();
 const options=db.defectOptions.map(v=>String(v||'').trim()).filter(Boolean);
 if(current && !options.some(v=>v.toLowerCase()===current.toLowerCase())) options.unshift(current);
 return `<div class="defect-slot"><div class="photo-title">Defect ${i+1}</div>
   <div class="photo-preview" id="preview-defect-${i}">${d.image?`<img src="${d.image}" alt="Defect ${i+1}">`:'<span>No photo</span>'}</div>
   <div class="photo-actions"><input type="file" accept="image/*" class="defect-input" data-defect="${i}"><button type="button" class="download-photo" data-download-defect="${i}" ${d.image?'':'disabled'}>DOWNLOAD</button><button type="button" class="danger remove-photo" data-remove-defect="${i}" ${d.image?'':'disabled'}>REMOVE PHOTO</button></div>
   <label class="small">Defect<select class="defect-label" data-defect-label="${i}"><option value="">Select defect…</option>${options.map(v=>`<option value="${esc(v)}" ${v.toLowerCase()===current.toLowerCase()?'selected':''}>${esc(v)}</option>`).join('')}</select></label>
   <label class="small">Classification<select class="defect-type" data-defect-type="${i}"><option value="">Select…</option><option value="Major" ${type==='Major'?'selected':''}>Major</option><option value="Minor" ${type==='Minor'?'selected':''}>Minor</option></select></label>
 </div>`;
}
function bindPhotoInputs(){
 document.querySelectorAll('.photo-input').forEach(inp=>inp.onchange=async e=>{
   const file=e.target.files[0]; if(!file)return;
   const data=await compressImage(file);
   const key=inp.dataset.photo; const p=document.getElementById(`preview-${key}`);
   if(p)p.innerHTML=`<img src="${data}" alt="${esc(key)}">`;
   inp.dataset.data=data; inp.dataset.remove='';
   const remove=document.querySelector(`[data-remove-photo="${key}"]`); if(remove)remove.disabled=false; const dl=document.querySelector(`[data-download-photo="${key}"]`); if(dl)dl.disabled=false;
 });
 document.querySelectorAll('.defect-input').forEach(inp=>inp.onchange=async e=>{
   const file=e.target.files[0]; if(!file)return;
   const data=await compressImage(file);
   const i=inp.dataset.defect; const p=document.getElementById(`preview-defect-${i}`);
   if(p)p.innerHTML=`<img src="${data}" alt="Defect ${i+1}">`;
   inp.dataset.data=data; inp.dataset.remove='';
   const remove=document.querySelector(`[data-remove-defect="${i}"]`); if(remove)remove.disabled=false; const dl=document.querySelector(`[data-download-defect="${i}"]`); if(dl)dl.disabled=false;
 });
 document.querySelectorAll('.download-photo').forEach(btn=>btn.onclick=()=>{
   let data=''; let name='audit-photo.jpg';
   if(btn.dataset.downloadPhoto!==undefined){const key=btn.dataset.downloadPhoto; const inp=document.querySelector(`.photo-input[data-photo="${key}"]`); data=inp?.dataset.data||((db.audits.find(a=>a.id==window.__activeAuditId)||{}).photos||{})[key]?.image||''; name=`${key}.jpg`;}
   if(btn.dataset.downloadDefect!==undefined){const i=btn.dataset.downloadDefect; const inp=document.querySelector(`.defect-input[data-defect="${i}"]`); data=inp?.dataset.data||((db.audits.find(a=>a.id==window.__activeAuditId)||{}).defectPhotos||[])[i]?.image||''; name=`defect-${Number(i)+1}.jpg`;}
   if(data){const a=document.createElement('a');a.href=data;a.download=name;document.body.appendChild(a);a.click();a.remove();}
 });
 document.querySelectorAll('.remove-photo').forEach(btn=>btn.onclick=()=>{
   if(btn.dataset.removePhoto!==undefined){const key=btn.dataset.removePhoto;const inp=document.querySelector(`.photo-input[data-photo="${key}"]`);if(inp){inp.value='';inp.dataset.data='';inp.dataset.remove='1';}const p=document.getElementById(`preview-${key}`);if(p)p.innerHTML='<span>No photo</span>';btn.disabled=true; const dl=document.querySelector(`[data-download-photo="${key}"]`); if(dl)dl.disabled=true;}
   if(btn.dataset.removeDefect!==undefined){const i=btn.dataset.removeDefect;const inp=document.querySelector(`.defect-input[data-defect="${i}"]`);if(inp){inp.value='';inp.dataset.data='';inp.dataset.remove='1';}const p=document.getElementById(`preview-defect-${i}`);if(p)p.innerHTML='<span>No photo</span>';btn.disabled=true; const dl=document.querySelector(`[data-download-defect="${i}"]`); if(dl)dl.disabled=true;}
 });
}
function compressImage(file,max=1100,quality=.72){
 return new Promise(resolve=>{
   const reader=new FileReader();
   reader.onload=()=>{
     const img=new Image();
     img.onload=()=>{
       const scale=Math.min(1,max/Math.max(img.width,img.height));
       const c=document.createElement('canvas');
       c.width=Math.max(1,Math.round(img.width*scale)); c.height=Math.max(1,Math.round(img.height*scale));
       c.getContext('2d').drawImage(img,0,0,c.width,c.height);
       resolve(c.toDataURL('image/jpeg',quality));
     };
     img.src=reader.result;
   };
   reader.readAsDataURL(file);
 });
}
async function collectPhotoData(){
 const out={};
 for(const inp of document.querySelectorAll('.photo-input')){
   const key=inp.dataset.photo;
   out[key]={image:inp.dataset.remove==='1'?'':(inp.dataset.data||((db.audits.find(a=>a.id==window.__activeAuditId)||{}).photos||{})[key]?.image||''),label:inp.dataset.photoLabel||((db.audits.find(a=>a.id==window.__activeAuditId)||{}).photos||{})[key]?.label||''};
 }
 return out;
}
async function collectDefectPhotoData(){
 const out=[]; const oldList=((db.audits.find(a=>a.id==window.__activeAuditId)||{}).defectPhotos||[]);
 document.querySelectorAll('.defect-slot').forEach((slot,i)=>{
   const inp=slot.querySelector('.defect-input'), label=slot.querySelector('.defect-label'), typeEl=slot.querySelector('.defect-type'), old=oldList[i]||{};
   out.push({image:inp?.dataset.remove==='1'?'':(inp?.dataset.data||old.image||''),label:label?.value||'',type:typeEl?.value||old.type||''});
 });
 return out;
}
function parseNum(v){
 const raw=String(v??'').replace(/,/g,'').trim().replace(/−/g,'-').replace(/–/g,'-');
 if(!raw)return null;
 const unicode={'¼':0.25,'½':0.5,'¾':0.75,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875};
 if(unicode[raw]!==undefined)return unicode[raw];
 const mixed=raw.match(/^(-?\d+)\s+(\d+)\/(\d+)$/);
 if(mixed){const sign=Number(mixed[1])<0?-1:1;const whole=Math.abs(Number(mixed[1]));const frac=Number(mixed[2])/Number(mixed[3]);return sign*(whole+frac);}
 const frac=raw.match(/^(-?\d+)\/(\d+)$/);
 if(frac)return Number(frac[1])/Number(frac[2]);
 const n=parseFloat(raw);
 return Number.isFinite(n)?n:null;
}

function buildSizeSections(x,totalSample){
 const saved=Array.isArray(x.measurementSections)?x.measurementSections:null;
 if(saved && saved.length) return saved.map(s=>({size:s.size||'',count:Math.max(1,parseInt(s.count||1,10)||1),rows:(s.rows||[]).map(r=>({pom:r.pom||'',spec:r.spec||'',tolMinus:r.tolMinus||'',tolPlus:r.tolPlus||'',values:Array.isArray(r.values)?r.values.slice():[]}))}));
 const rows=x.measurementRows||[];
 const sizes=Array.isArray(x.measurementSizes)?x.measurementSizes:[];
 if(!rows.length){return [{size:'',count:Math.max(1,totalSample||1),rows:[{pom:'',spec:'',tolMinus:'',tolPlus:'',values:Array(Math.max(1,totalSample||1)).fill('')}]}];}
 const groups=[];
 const bySize=new Map();
 rows.forEach(r=>{
   const vals=r.values||[];
   const size=String(r.size||'').trim() || String(sizes.find(v=>String(v).trim())||'').trim();
   const key=size||'Unspecified';
   if(!bySize.has(key)){bySize.set(key,{size:size==='Unspecified'?'':size,count:Math.max(1,vals.length),rows:[]});groups.push(bySize.get(key));}
   const g=bySize.get(key); g.count=Math.max(g.count,vals.length||1); g.rows.push({pom:r.pom||'',spec:r.spec||'',tolMinus:r.tolMinus||'',tolPlus:r.tolPlus||'',values:vals.slice()});
 });
 let used=groups.reduce((n,g)=>n+g.count,0);
 if(used<totalSample) groups[groups.length-1].count += totalSample-used;
 return groups;
}
function renderSizeSection(sec,idx,totalSample){
 const count=Math.max(1,parseInt(sec.count||1,10)||1);
 const rows=sec.rows&&sec.rows.length?sec.rows:[{pom:'',spec:'',tolMinus:'',tolPlus:'',values:Array(count).fill('')}];
 return `<div class="size-section" data-size-section="${idx}"><div class="size-section-head"><label><b>Size</b><input class="size-section-size" value="${esc(sec.size||'')}" placeholder="XS, S, M, L, XL"></label><label><b>Garments in this size</b><input class="size-section-count" type="number" min="1" max="100" value="${count}"></label><button type="button" class="danger remove-size-section">REMOVE SIZE</button></div><div class="tablewrap measurementwrap"><table class="measurementtable size-measurement-table"><thead><tr><th>Select</th><th>POM</th><th>Tol. -</th><th>Tol. +</th><th>Spec.</th>${Array.from({length:count},(_,i)=>`<th>Garment ${i+1}<br><span class="small">Measurement</span></th><th>OOT?</th><th>OOT By</th>`).join('')}</tr></thead><tbody>${rows.map((r,ri)=>`<tr data-srow="${ri}"><td><input type="checkbox" class="pom-select" aria-label="Select ${esc(r.pom||'POM')}"></td><td><input class="mpom" value="${esc(r.pom||'')}" placeholder="e.g. Waist"></td><td><input class="mtolminus" value="${esc(r.tolMinus??'')}" placeholder="1" inputmode="decimal"></td><td><input class="mtolplus" value="${esc(r.tolPlus??'')}" placeholder="1" inputmode="decimal"></td><td><input class="mspec" value="${esc(r.spec??'')}" placeholder="32.00" inputmode="decimal"></td>${Array.from({length:count},(_,i)=>{const val=(r.values||[])[i]||'';const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,val);return `<td><input class="mval" data-g="${i}" value="${esc(val)}" inputmode="decimal" placeholder="0.00"></td><td><span class="oot ${st.status.startsWith('OUT')?'bad':st.status==='IN'?'good':''}" data-oot="${i}">${st.status}</span></td><td><span class="ootby" data-ootby="${i}">${st.status.startsWith('OUT')?st.variance:'—'}</span></td>`}).join('')}</tr>`).join('')}</tbody></table></div><div class="toolbar"><button type="button" class="add-section-pom">+ ADD POM TO ${esc(sec.size||'SIZE')}</button><button type="button" class="danger delete-selected-poms">DELETE SELECTED POMs</button></div></div>`;
}
function renderSizeSections(sections,totalSample){
 const box=document.getElementById('sizeSections'); if(!box)return;
 box.innerHTML=sections.map((s,i)=>renderSizeSection(s,i,totalSample)).join('');
 bindSizeSections();
}
function bindSizeSections(){
 document.querySelectorAll('.size-section-count').forEach(inp=>inp.onchange=()=>{const secs=collectSizeSections();const idx=+inp.closest('.size-section').dataset.sizeSection;const n=Math.max(1,Math.min(100,parseInt(inp.value||1,10)||1));if(secs[idx]){secs[idx].count=n;secs[idx].rows.forEach(r=>r.values=(r.values||[]).slice(0,n).concat(Array(Math.max(0,n-(r.values||[]).length)).fill(''))); }renderSizeSections(secs,1);});
 document.querySelectorAll('.remove-size-section').forEach(b=>b.onclick=()=>{const secs=collectSizeSections();const idx=+b.closest('.size-section').dataset.sizeSection;if(secs.length<=1){alert('At least one size section is required.');return;}secs.splice(idx,1);renderSizeSections(secs,1);});
 document.querySelectorAll('.add-section-pom').forEach(b=>b.onclick=()=>{const secs=collectSizeSections();const idx=+b.closest('.size-section').dataset.sizeSection;secs[idx].rows.push({pom:'',spec:'',tolMinus:'',tolPlus:'',values:Array(secs[idx].count).fill('')});renderSizeSections(secs,1);});
 document.querySelectorAll('.delete-selected-poms').forEach(b=>b.onclick=()=>{const section=b.closest('.size-section');const selected=[...section.querySelectorAll('.pom-select:checked')];if(!selected.length){alert('Select at least one POM to delete.');return;}if(!confirm(`Delete ${selected.length} selected POM${selected.length===1?'':'s'} from this size?`))return;const secs=collectSizeSections();const idx=+section.dataset.sizeSection;const remove=new Set(selected.map(c=>+c.closest('tr').dataset.srow));secs[idx].rows=secs[idx].rows.filter((_,i)=>!remove.has(i));if(!secs[idx].rows.length)secs[idx].rows=[{pom:'',spec:'',tolMinus:'',tolPlus:'',values:Array(secs[idx].count).fill('')}];renderSizeSections(secs,1);});
 document.querySelectorAll('.mval,.mspec,.mtolminus,.mtolplus').forEach(el=>el.addEventListener('input',updateSizeMeasurementStatuses));
}
function collectSizeSections(){
 return [...document.querySelectorAll('.size-section')].map(sec=>{const count=Math.max(1,parseInt(sec.querySelector('.size-section-count')?.value||1,10)||1);const size=sec.querySelector('.size-section-size')?.value||'';const rows=[...sec.querySelectorAll('tbody tr[data-srow]')].map(tr=>({pom:tr.querySelector('.mpom')?.value||'',spec:tr.querySelector('.mspec')?.value||'',tolMinus:tr.querySelector('.mtolminus')?.value||'',tolPlus:tr.querySelector('.mtolplus')?.value||'',values:[...tr.querySelectorAll('.mval')].slice(0,count).map(i=>i.value||'')}));return {size,count,rows};});
}
function updateSizeMeasurementStatuses(){
 document.querySelectorAll('.size-section tbody tr[data-srow]').forEach(tr=>{const spec=tr.querySelector('.mspec')?.value||'',tm=tr.querySelector('.mtolminus')?.value||'',tp=tr.querySelector('.mtolplus')?.value||'';tr.querySelectorAll('.mval').forEach(inp=>{const g=inp.dataset.g,st=measurementStatus(spec,tm,tp,inp.value),o=tr.querySelector(`[data-oot="${g}"]`),b=tr.querySelector(`[data-ootby="${g}"]`);if(o){o.textContent=st.status;o.className=`oot ${st.status.startsWith('OUT')?'bad':st.status==='IN'?'good':''}`;}if(b)b.textContent=st.status.startsWith('OUT')?st.variance:'—';});});
}
const TOLERANCE_GRACE=0.125; // ±1/8 inch grace beyond the stated POM tolerance before a measurement is considered a failure
function measurementStatus(spec,tolMinus,tolPlus,val){
 const n=parseNum(spec), tmRaw=parseNum(tolMinus), tpRaw=parseNum(tolPlus), v=parseNum(val);
 if(v===null||n===null||tmRaw===null||tpRaw===null)return {status:'—',variance:'—'};
 const tm=Math.abs(tmRaw), tp=Math.abs(tpRaw);
 const lower=n-tm-TOLERANCE_GRACE, upper=n+tp+TOLERANCE_GRACE;
 if(v<lower)return {status:'OUT -',variance:(lower-v).toFixed(2)};
 if(v>upper)return {status:'OUT +',variance:(v-upper).toFixed(2)};
 return {status:'IN',variance:'0.00'};
}

function buildMeasurementTable(rows,count){
 if(rows && rows.length) return rows;
 return [{pom:'',size:'',spec:'',tolMinus:'',tolPlus:'',values:Array(count).fill('')}];
}
function renderMeasurementTable(rows,count,sizes=[]){
 const head=document.getElementById('measurementHead'), body=document.getElementById('measurementBody');
 if(!head||!body)return;
 const normalizedSizes=Array.from({length:count},(_,i)=>sizes[i] ?? (rows||[]).find(r=>String(r.size||'').trim())?.size ?? '');
 head.innerHTML='<tr><th>POM</th><th>Spec</th><th>Tol. -</th><th>Tol. +</th>'+Array.from({length:count},(_,i)=>`<th>Garment ${i+1}<br><label class="small">Size <input class="msize-col" data-g="${i}" value="${esc(normalizedSizes[i])}" placeholder="S, M, L"></label><br><span class="small">Measurement</span></th><th>OOT?</th><th>OOT By</th>`).join('')+'</tr>';
 body.innerHTML=(rows||[]).map((r,ri)=>`<tr data-mrow="${ri}">
   <td><input class="mpom" value="${esc(r.pom||'')}" placeholder="e.g. Chest"></td>
   <td><input class="mspec" value="${esc(r.spec||'')}" placeholder="22.00"></td>
   <td><input class="mtolminus" value="${esc(r.tolMinus??'')}" placeholder="0.50" inputmode="decimal"></td>
   <td><input class="mtolplus" value="${esc(r.tolPlus??'')}" placeholder="0.50" inputmode="decimal"></td>
   ${Array.from({length:count},(_,i)=>{
      const val=(r.values||[])[i]||'';
      const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,val);
      return `<td><input class="mval" data-g="${i}" value="${esc(val)}" inputmode="decimal" placeholder="0.00"></td>
              <td><span class="oot ${st.status.startsWith('OUT')?'bad':st.status==='IN'?'good':''}" data-oot="${i}">${st.status}</span></td>
              <td><span class="ootby" data-ootby="${i}">${st.status.startsWith('OUT')?st.variance:'—'}</span></td>`;
   }).join('')}
 </tr>`).join('');
 body.querySelectorAll('.mval,.mspec,.mtolminus,.mtolplus').forEach(el=>el.addEventListener('input',updateMeasurementStatuses));
}
function updateMeasurementStatuses(){
 document.querySelectorAll('#measurementBody tr[data-mrow]').forEach(tr=>{
   const spec=tr.querySelector('.mspec')?.value||'', tm=tr.querySelector('.mtolminus')?.value||'', tp=tr.querySelector('.mtolplus')?.value||'';
   tr.querySelectorAll('.mval').forEach(inp=>{
      const g=inp.dataset.g, st=measurementStatus(spec,tm,tp,inp.value);
      const o=tr.querySelector(`[data-oot="${g}"]`), b=tr.querySelector(`[data-ootby="${g}"]`);
      if(o){o.textContent=st.status;o.className=`oot ${st.status.startsWith('OUT')?'bad':st.status==='IN'?'good':''}`;}
      if(b)b.textContent=st.status.startsWith('OUT')?st.variance:'—';
   });
 });
}
function collectMeasurementSizes(){ return [...document.querySelectorAll('.msize-col')].map(i=>i.value||''); }
function collectMeasurementRows(){
 const sizes=collectMeasurementSizes(); const rows=[]; document.querySelectorAll('#measurementBody tr[data-mrow]').forEach(tr=>{
   const vals=[...tr.querySelectorAll('.mval')].map(i=>i.value);
   rows.push({
     pom:tr.querySelector('.mpom')?.value||'',
     size:sizes.find(v=>String(v).trim())||'',
     spec:tr.querySelector('.mspec')?.value||'',
     tolMinus:tr.querySelector('.mtolminus')?.value||'',
     tolPlus:tr.querySelector('.mtolplus')?.value||'',
     values:vals
   });
 }); return rows;
}

function defectAcceptance(x){
 const sample=Math.max(1,parseInt(x?.sample||x?.aql||1,10)||1);
 // AQL major-defect acceptance points supplied for this workflow. Values between points use the last applicable point.
 const table=[[5,0],[8,0],[13,1],[20,1],[32,2]];
 let allowed=null;
 for(const [threshold,max] of table){ if(sample>=threshold) allowed=max; else break; }
 const defects=(x?.defectPhotos||[]).filter(d=>d && (d.image || String(d.label||'').trim()) && (d.type==='Major' || d.type==='Minor'));
 const major=defects.filter(d=>d.type==='Major').length;
 const minor=defects.filter(d=>d.type==='Minor').length;
 const effective=major+Math.floor(minor/3);
 const minorGrace=minor%3;
 if(allowed===null) return {sample,allowed:null,major,minor,effective,minorGrace,pass:true,label:`No major-defect limit mapped for sample ${sample}`};
 const pass=effective<=allowed;
 return {sample,allowed,major,minor,effective,minorGrace,pass,label:pass?`PASS — ${effective} effective major / ${allowed} allowable (3 minor defects equal 1 major defect)`: `FAIL — ${effective} effective major exceeds ${allowed} allowable`};
}

function measurementAcceptance(measurementCount){
 const table=[[8,0],[13,1],[20,1],[32,2],[50,3],[65,4],[80,5],[101,6],[125,7],[148,8],[173,9],[200,10],[225,11],[251,12],[278,13],[315,14],[340,15],[365,16],[390,17],[416,18]];
 let allowed=0;
 for(const [threshold,max] of table){ if(measurementCount>=threshold) allowed=max; else break; }
 return {allowed, status: measurementCount>0 && measurementCount<=416 ? 'mapped' : (measurementCount>416?'extended':'none')};
}
function auditPomStats(x){
 const rows=x.measurementRows||[];
 const count=Math.max(1,parseInt(x.sample||x.aql||1,10)||1);
 const stats={};
 let totalMeasurements=0, outMinus=0, outPlus=0;
 rows.forEach(r=>{
   const pom=String(r.pom||'').trim();
   if(pom && !stats[pom])stats[pom]={measured:false,minus:false,plus:false};
   (r.values||[]).slice(0,count).forEach(v=>{
     if(String(v).trim()==='')return;
     const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,v);
     totalMeasurements++;
     if(pom)stats[pom].measured=true;
     if(st.status==='OUT -'){outMinus++;if(pom)stats[pom].minus=true;}
     if(st.status==='OUT +'){outPlus++;if(pom)stats[pom].plus=true;}
   });
 });
 const pomMeasured=Object.values(stats).filter(z=>z.measured).length;
 const pomMinus=Object.values(stats).filter(z=>z.minus).length;
 const pomPlus=Object.values(stats).filter(z=>z.plus).length;
 const totalOOTMeasurements=outMinus+outPlus;
 const rule=measurementAcceptance(totalMeasurements);
 return {pomMeasured,pomMinus,pomPlus,totalMeasurements,outMinus,outPlus,totalOOTMeasurements,allowed:rule.allowed,pass:totalMeasurements>0 && totalOOTMeasurements<=rule.allowed};
}
function measurementDistributionChart(x,sections){
 const bins=[
  {v:-1.25,label:'−1 1/4'}, {v:-1.125,label:'−1 1/8'}, {v:-1,label:'−1'}, {v:-0.875,label:'−7/8'},
  {v:-0.75,label:'−3/4'}, {v:-0.625,label:'−5/8'}, {v:-0.5,label:'−1/2'}, {v:-0.375,label:'−3/8'},
  {v:-0.25,label:'−1/4'}, {v:-0.125,label:'−1/8'}, {v:0,label:'0'}, {v:0.125,label:'1/8'},
  {v:0.25,label:'1/4'}, {v:0.375,label:'3/8'}, {v:0.5,label:'1/2'}, {v:0.625,label:'5/8'},
  {v:0.75,label:'3/4'}, {v:0.875,label:'7/8'}, {v:1,label:'1'}, {v:1.125,label:'1 1/8'}, {v:1.25,label:'1 1/4'}
 ];
 // Combine the same POM across every garment size. Counts are aggregated, while
 // tolerance coloring uses the union of every tolerance range found for that POM.
 const grouped=new Map();
 sections.forEach(sec=>{
   (sec.rows||[]).filter(r=>String(r.pom||r.spec||r.tolMinus||r.tolPlus||'').trim()||(r.values||[]).some(v=>String(v).trim()!==''))
   .forEach(r=>{
     const raw=String(r.pom||'Unspecified POM').trim()||'Unspecified POM';
     const key=raw.toLowerCase();
     if(!grouped.has(key)) grouped.set(key,{pom:raw,total:0,minus:0,plus:0,binCounts:Array(bins.length).fill(0),ootBins:new Set(),ranges:[],sizes:new Set()});
     const g=grouped.get(key); g.sizes.add(sec.size||'Unspecified size');
     const tm=parseNum(r.tolMinus),tp=parseNum(r.tolPlus);
     if(tm!==null||tp!==null) g.ranges.push({tm:tm===null?null:Math.abs(tm),tp:tp===null?null:Math.abs(tp),size:sec.size||'Unspecified size'});
     (r.values||[]).slice(0,Math.max(1,sec.count||1)).forEach(v=>{
       if(String(v).trim()==='')return;
       const spec=parseNum(r.spec),actual=parseNum(v); if(spec===null||actual===null)return;
       const variance=actual-spec; let idx=Math.round(variance*8)+10; idx=Math.max(0,Math.min(bins.length-1,idx));
       g.binCounts[idx]++; g.total++;
       const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,v);
       if(st.status==='OUT -'){g.minus++;g.ootBins.add(idx)}
       if(st.status==='OUT +'){g.plus++;g.ootBins.add(idx)}
     });
   });
 });
 const rows=[...grouped.values()];
 const grandTotal=rows.reduce((n,r)=>n+r.total,0),grandMinus=rows.reduce((n,r)=>n+r.minus,0),grandPlus=rows.reduce((n,r)=>n+r.plus,0);
 const grandBins=bins.map((_,i)=>rows.reduce((n,r)=>n+r.binCounts[i],0));
 const pct=(n,d)=>n===0?'—':(d?(n/d*100).toFixed(1)+'%':'—');
 const fmtTol=(rowsForPom,which)=>{
   const vals=[...new Set(rowsForPom.ranges.map(r=>r[which]).filter(v=>v!==null).map(v=>Number(v).toFixed(4)))];
   if(!vals.length)return '—';
   if(vals.length===1)return esc(vals[0].replace(/\.0000$/,'').replace(/(\.\d*?)0+$/,'$1'));
   return 'Varies';
 };
 const header=`<tr><th class="dist-pom">P.O.M.</th><th class="dist-tol">Tol. −</th><th class="dist-tol">Tol. +</th><th class="dist-pct">% of<br>sample out<br>of tolerance</th>${bins.map(b=>`<th class="dist-bin" title="Variance from spec: ${b.label}">${esc(b.label)}</th>`).join('')}<th class="dist-total">Total</th><th class="dist-oot">− tolerance</th><th class="dist-oot">+ tolerance</th></tr>`;
 const body=rows.map(r=>{
   const outsidePossible=i=>r.ranges.length>0 && r.ranges.some(range=>(range.tm!==null && bins[i].v < -range.tm) || (range.tp!==null && bins[i].v > range.tp));
   return `<tr><td class="dist-pom"><b>${esc(r.pom)}</b></td><td class="dist-tol">${fmtTol(r,'tm')}</td><td class="dist-tol">${fmtTol(r,'tp')}</td><td class="dist-pct">${pct(r.minus+r.plus,r.total)}</td>${r.binCounts.map((n,i)=>{const outside=outsidePossible(i),actualOOT=r.ootBins.has(i);const cls=`dist-bin ${outside?'dist-outside-tol':'dist-within-tol'} ${actualOOT?'dist-oot-cell':''}`;const title=outside?'Outside at least one size\'s POM tolerance':'Within all combined POM tolerance ranges';return `<td class="${cls}" title="${title}; ${n} measurement${n===1?'':'s'} in this variance bin">${n===0?'—':n}</td>`;}).join('')}<td class="dist-total"><b>${r.total===0?'—':r.total}</b></td><td class="dist-oot">${r.minus===0?'—':r.minus}</td><td class="dist-oot">${r.plus===0?'—':r.plus}</td></tr>`;
 }).join('');
 const footer=`<tr class="dist-total-row"><td class="dist-pom"><b>Total</b></td><td class="dist-tol">—</td><td class="dist-tol">—</td><td class="dist-pct"><b>${pct(grandMinus+grandPlus,grandTotal)}</b></td>${grandBins.map((n,i)=>{const anyOutside=rows.some(r=>r.ranges.length>0&&r.ranges.some(range=>(range.tm!==null && bins[i].v < -range.tm) || (range.tp!==null && bins[i].v > range.tp)));return `<td class="dist-bin ${anyOutside?'dist-outside-tol':'dist-within-tol'}"><b>${n===0?'—':n}</b></td>`;}).join('')}<td class="dist-total"><b>${grandTotal===0?'—':grandTotal}</b></td><td class="dist-oot"><b>${grandMinus===0?'—':grandMinus}</b></td><td class="dist-oot"><b>${grandPlus===0?'—':grandPlus}</b></td></tr>`;
 const empty=!rows.length?`<div class="dist-empty">Enter measurements to populate the distribution chart.</div>`:'';
 const distinctRows=rows.length, sizeCount=sections.length;
 return `<div class="measurement-distribution"><div class="distribution-title"><div><h3>Measurement Distribution by POM</h3><p>All sizes are combined by POM. Every possible out-of-tolerance variance cell is based on the stated POM tolerance.</p><div class="distribution-metrics"><span><b>Size Sections:</b> ${sizeCount}</span><span><b>Distinct POMs:</b> ${distinctRows}</span><span><b>Measurements OOT:</b> ${grandMinus+grandPlus}</span><span><b>Total Measurements:</b> ${grandTotal}</span></div></div><strong>— OOT</strong></div><div class="distribution-scroll"><table class="distribution-table"><thead>${header}</thead><tbody>${body||''}${footer}</tbody></table></div>${empty}</div>`;
}

function summaryHtml(x){
 const sections=Array.isArray(x.measurementSections)&&x.measurementSections.length
   ? x.measurementSections.map(s=>({size:String(s.size||'').trim()||'Unspecified size',count:Math.max(1,parseInt(s.count||1,10)||1),rows:s.rows||[]}))
   : (()=>{const groups=new Map();(x.measurementRows||[]).forEach(r=>{const size=String(r.size||'').trim()||'Unspecified size';if(!groups.has(size))groups.set(size,{size,count:0,rows:[]});const g=groups.get(size);g.count=Math.max(g.count,(r.values||[]).length);g.rows.push(r)});return [...groups.values()]})();
 let total=0,oot=0,outMinus=0,outPlus=0;const pomStats=new Map();
 const sizeBlocks=sections.map(sec=>{
   const rows=sec.rows.filter(r=>String(r.pom||r.spec||r.tolMinus||r.tolPlus||'').trim()||(r.values||[]).some(v=>String(v).trim()!==''));
   const body=rows.map(r=>{
     let measured=0,outs=0,minus=0,plus=0;
     const cells=Array.from({length:sec.count},(_,i)=>{const v=(r.values||[])[i]??'';if(String(v).trim()==='')return '<td class="measurement-empty">—</td><td>—</td><td>—</td>';const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,v);measured++;total++;const out=st.status.startsWith('OUT');if(out){outs++;oot++;if(st.status==='OUT -'){minus++;outMinus++;}else{plus++;outPlus++;}}return `<td>${esc(v)}</td><td class="measurement-in">${st.status}</td><td class="${out?'oot-highlight':''}">${out?esc(st.variance):'—'}</td>`;}).join('');
     const name=String(r.pom||'Unspecified POM').trim();const key=`${sec.size}||${name}`;const stat=pomStats.get(key)||{size:sec.size,pom:name,measured:0,oot:0,minus:0,plus:0};stat.measured+=measured;stat.oot+=outs;stat.minus+=minus;stat.plus+=plus;pomStats.set(key,stat);
     return `<tr class="${outs?'oot-row':''}"><td class="${outs?'oot-highlight':''}"><b>${esc(name)}</b>${outs?' ⚠':''}</td><td>${esc(r.spec||'—')}</td><td>${esc(r.tolMinus||'—')}</td><td>${esc(r.tolPlus||'—')}</td>${cells}<td>${measured}</td><td>${outs}</td></tr>`;
   }).join('');
   return `<section class="summary-size-block"><h4>Size: ${esc(sec.size)} <span>(${sec.count} garment${sec.count===1?'':'s'} sampled)</span></h4><div class="tablewrap"><table class="summary-detail size-summary-table"><thead><tr><th rowspan="2">POM</th><th rowspan="2">Spec</th><th rowspan="2">Tol. −</th><th rowspan="2">Tol. +</th>${Array.from({length:sec.count},(_,i)=>`<th colspan="3">Garment ${i+1}</th>`).join('')}<th rowspan="2">IN</th><th rowspan="2">OOT</th></tr><tr>${Array.from({length:sec.count},()=>'<th>Actual</th><th>Status</th><th>By</th>').join('')}</tr></thead><tbody>${body||`<tr><td colspan="${6+sec.count*3}">No measurement data entered for this size.</td></tr>`}</tbody></table></div></section>`;
 }).join('');
 const chart=measurementDistributionChart(x,sections);
 return chart+`<h3 class="summary-detail-heading">Measurement Detail by Size</h3>${sizeBlocks}`;
}

function templatePomRow(p={}){
 return `<div class="template-pom-row"><input class="tpom" placeholder="POM name" value="${esc(p.pom||'')}"><input class="tspec" placeholder="Spec (optional)" value="${esc(p.spec||'')}"><input class="ttm" placeholder="Tol. -" value="${esc(p.tolMinus||'')}"><input class="ttp" placeholder="Tol. +" value="${esc(p.tolPlus||'')}"><button type="button" class="danger remove-template-pom">REMOVE</button></div>`;
}
function editTemplateForm(id){
 if(db.user!=='Manager')return; const t=db.garmentTemplates.find(x=>x.id===id); if(!t)return; const box=document.getElementById('templateEditor'); if(!box)return;
 box.innerHTML=`<h3>Edit Template: ${esc(t.name)}</h3><form id="templateForm"><input type="hidden" name="templateId" value="${esc(t.id)}"><label>Garment Type Name<input name="templateName" value="${esc(t.name)}" required></label><div id="templatePomRows" class="template-poms">${t.poms.map(templatePomRow).join('')}</div><button type="button" id="templateAddPom">+ ADD POM</button><button class="primary" type="submit">SAVE TEMPLATE</button><button type="button" id="cancelTemplateEdit">CANCEL</button></form>`;
 const maf=document.getElementById('managerAccountForm'); if(maf) maf.onsubmit=async e=>{e.preventDefault();if(db.user!=='Manager')return;const username=document.getElementById('managerUsername').value.trim();const password=document.getElementById('managerPassword').value;if(!username){alert('Manager username is required.');return;}if(db.auditorAccounts.some(a=>String(a.username||'').toLowerCase()===username.toLowerCase())){alert('Manager username must be different from every auditor username.');return;}db.managerAccount.username=username;if(password)db.managerAccount.passwordHash=await hashPassword(password);save();alert('Manager login saved.');};
 const sf=document.getElementById('supplierForm'); if(sf) sf.onsubmit=e=>{e.preventDefault(); if(db.user!=='Manager')return; const rows=[...sf.querySelectorAll('#supplierRows tr')]; const vals=rows.map(r=>({name:r.querySelector('.supplier-name')?.value.trim()||'',coo:r.querySelector('.supplier-coo')?.value.trim()||''})); if(vals.some(v=>!v.name||!v.coo)){alert('Supplier and COO are required.');return;} if(new Set(vals.map(v=>v.name.toLowerCase())).size!==vals.length){alert('Supplier names must be unique.');return;} db.suppliers=vals; db.audits.forEach(a=>{const match=vals.find(v=>v.name.toLowerCase()===String(a.supplier||'').toLowerCase()); if(match){a.supplier=match.name;a.coo=match.coo;}}); save(); render(); alert('Supplier changes saved.');};
 const addSupplier=document.getElementById('addSupplier'); if(addSupplier) addSupplier.onclick=()=>{const tbody=document.getElementById('supplierRows'); const n=tbody?.querySelectorAll('tr').length||0; const tr=document.createElement('tr'); tr.innerHTML=`<td>${n+1}</td><td><input class="supplier-name" data-original="" value="" placeholder="Supplier name" required></td><td><input class="supplier-coo" value="" placeholder="Country of origin" required></td><td><button type="button" class="danger remove-supplier">REMOVE</button></td>`; tbody?.appendChild(tr);};
 document.querySelectorAll('.remove-supplier').forEach(b=>b.onclick=()=>{b.closest('tr')?.remove();[...document.querySelectorAll('#supplierRows tr')].forEach((r,i)=>r.children[0].textContent=i+1);});
 const df=document.getElementById('defectForm'); if(df) df.onsubmit=e=>{e.preventDefault();if(db.user!=='Manager')return;const vals=[...df.querySelectorAll('.defect-option-name')].map(i=>i.value.trim()).filter(Boolean);if(new Set(vals.map(v=>v.toLowerCase())).size!==vals.length){alert('Defect names must be unique.');return;}db.defectOptions=vals;save();render();alert('Defect list saved.');};
 const addDefectOption=document.getElementById('addDefectOption'); if(addDefectOption) addDefectOption.onclick=()=>{const tbody=document.getElementById('defectRows');if(!tbody)return;if(tbody.querySelector('td[colspan]'))tbody.innerHTML='';const n=tbody.querySelectorAll('tr').length;const tr=document.createElement('tr');tr.innerHTML=`<td>${n+1}</td><td><input class="defect-option-name" value="" placeholder="e.g. Broken stitch" required></td><td><button type="button" class="danger remove-defect-option">REMOVE</button></td>`;tbody.appendChild(tr);tr.querySelector('input')?.focus();bindManagerDefectRows();};
 bindManagerDefectRows();
 bindTemplateEditor();
}
function bindManagerDefectRows(){document.querySelectorAll('.remove-defect-option').forEach(b=>{b.onclick=()=>{b.closest('tr')?.remove();[...document.querySelectorAll('#defectRows tr')].forEach((r,i)=>r.children[0].textContent=i+1);};});}
function bindTemplateEditor(){
 const f=document.getElementById('templateForm'); if(!f)return; f.onsubmit=e=>{e.preventDefault(); if(db.user!=='Manager')return; const d=Object.fromEntries(new FormData(f)); const name=(d.templateName||'').trim(); const poms=[...document.querySelectorAll('.template-pom-row')].map(r=>({pom:r.querySelector('.tpom')?.value.trim()||'',spec:r.querySelector('.tspec')?.value.trim()||'',tolMinus:r.querySelector('.ttm')?.value.trim()||'',tolPlus:r.querySelector('.ttp')?.value.trim()||''})).filter(x=>x.pom); if(!name||!poms.length){alert('Template name and at least one POM are required.');return;} if(db.garmentTemplates.some(t=>t.name.toLowerCase()===name.toLowerCase() && t.id!==d.templateId)){alert('A garment template with this name already exists.');return;} const idx=db.garmentTemplates.findIndex(t=>t.id===d.templateId); if(idx>=0) db.garmentTemplates[idx]={id:d.templateId,name,poms}; else db.garmentTemplates.push({id:crypto.randomUUID(),name,poms}); save(); render(); alert('Garment template saved.');};
 const a=document.getElementById('templateAddPom'); if(a)a.onclick=()=>document.getElementById('templatePomRows').insertAdjacentHTML('beforeend',templatePomRow());
 document.querySelectorAll('.remove-template-pom').forEach(b=>b.onclick=()=>b.closest('.template-pom-row')?.remove());
 const c=document.getElementById('cancelTemplateEdit'); if(c)c.onclick=()=>render();
}
function supplierReportDateMatch(x,start,end){const raw=x.status==='Completed'?x.complete:null;if(!raw)return false;const d=new Date(raw);if(Number.isNaN(d.getTime()))return false;if(start&&d<new Date(start+'T00:00:00'))return false;if(end&&d>new Date(end+'T23:59:59.999'))return false;return true;}
function supplierReportFilter(a){const start=document.getElementById('supplierStartDate')?.value||'',end=document.getElementById('supplierEndDate')?.value||'';return {start,end,invalid:!!(start&&end&&start>end),rows:a.filter(x=>supplierReportDateMatch(x,start,end))};}
function supplierReportSuppliers(a){const n=new Set((db.suppliers||[]).map(x=>String(x.name||'').trim()).filter(Boolean));a.forEach(x=>{const s=String(x.supplier||'').trim();if(s)n.add(s)});return [...n].sort((a,b)=>a.localeCompare(b));}
function supplierReportData(a,supplier,start,end){const rows=a.filter(x=>String(x.supplier||'').trim().toLowerCase()===supplier.toLowerCase()&&supplierReportDateMatch(x,start,end)),passed=rows.filter(x=>String(x.result||'').toUpperCase()==='PASS').length,defects=[],measurements=[];rows.forEach(x=>{(x.defectPhotos||[]).forEach(d=>{if(d&&String(d.label||'').trim()&&(d.type==='Major'||d.type==='Minor'))defects.push({po:x.po||'—',style:x.style||'—',name:String(d.label).trim(),type:d.type,date:x.complete})});(x.measurementRows||[]).forEach(r=>(r.values||[]).forEach((v,i)=>{if(String(v).trim()==='')return;const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,v);if(st.status==='OUT -'||st.status==='OUT +')measurements.push({po:x.po||'—',style:x.style||'—',pom:r.pom||'—',size:r.size||((x.measurementSizes||[])[i])||'—',value:v,status:st.status,spec:r.spec||'—',tolMinus:r.tolMinus||'—',tolPlus:r.tolPlus||'—'})}));});return {supplier,rows,passed,passRate:rows.length?passed/rows.length*100:0,defects,measurements};}
function supplierReport(a){if(db.user!=='Manager')return '<h2>Supplier Reports</h2><p class="muted">Supplier reporting is available to the Manager only.</p>';const f=supplierReportFilter(a),ss=supplierReportSuppliers(a);if(supplierReportSelection&&!ss.includes(supplierReportSelection))supplierReportSelection='';const d=supplierReportSelection?supplierReportData(a,supplierReportSelection,f.start,f.end):null;if(f.invalid)return '<div class="section"><h2>Supplier Reports</h2><p>Please choose a valid date range.</p></div>';const def=d?.defects||[],meas=d?.measurements||[];return `<div class="auditrow"><div><h2>Supplier Reports</h2><p class="muted">Overall Quality Score is determined only by PO pass rate.</p></div>${d?'<button class="primary" id="printSupplierReport">PRINT SUPPLIER REPORT</button>':''}</div><div class="section"><div class="grid"><label>Supplier<select id="supplierReportSelect"><option value="">Select supplier…</option>${ss.map(x=>`<option ${x===supplierReportSelection?'selected':''}>${esc(x)}</option>`).join('')}</select></label><label>From<input type="date" id="supplierStartDate" value="${esc(f.start)}"></label><label>To<input type="date" id="supplierEndDate" value="${esc(f.end)}"></label></div><button id="clearSupplierDates">CLEAR DATES</button></div>${d?`<div class="section"><div class="cards"><div class="card">Overall Quality Score<div class="num">${d.passRate.toFixed(1)}%</div><div class="muted small">PO Pass Rate Only</div></div><div class="card">POs Audited<div class="num">${d.rows.length}</div></div><div class="card">Passed POs<div class="num">${d.passed}</div></div><div class="card">Failed POs<div class="num">${d.rows.length-d.passed}</div></div><div class="card">Major Defects<div class="num">${def.filter(x=>x.type==='Major').length}</div></div><div class="card">Minor Defects<div class="num">${def.filter(x=>x.type==='Minor').length}</div></div><div class="card">Measurement Failures<div class="num">${meas.length}</div></div></div></div><div class="section"><h3>Defects</h3><div class="tablewrap"><table><thead><tr><th>PO</th><th>Style</th><th>Defect</th><th>Type</th><th>Completed</th></tr></thead><tbody>${def.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.name)}</td><td>${esc(x.type)}</td><td>${dt(x.date)}</td></tr>`).join('')||'<tr><td colspan="5">No defects.</td></tr>'}</tbody></table></div></div><div class="section"><h3>Measurement Failures</h3><div class="tablewrap"><table><thead><tr><th>PO</th><th>Style</th><th>POM</th><th>Size</th><th>Measured</th><th>Failure</th></tr></thead><tbody>${meas.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.pom)}</td><td>${esc(x.size)}</td><td>${esc(x.value)}</td><td>${esc(x.status)}</td></tr>`).join('')||'<tr><td colspan="6">No measurement failures.</td></tr>'}</tbody></table></div></div>`:'<div class="section"><p class="muted">Select a supplier to view its report.</p></div>'}`;}
function printSupplierReport(){const f=supplierReportFilter(db.audits);if(f.invalid||!supplierReportSelection){alert(f.invalid?'Please choose a valid date range.':'Select a supplier before printing.');return}const d=supplierReportData(db.audits,supplierReportSelection,f.start,f.end),def=d.defects,meas=d.measurements,w=window.open('','_blank','width=1100,height=800');if(!w){alert('Please allow pop-ups to print Supplier Reports.');return}w.document.write(`<!doctype html><html><head><title>Supplier Quality Report</title><style>body{font-family:Arial;margin:30px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #aaa;padding:7px;text-align:left}th{background:#eee}.score{font-size:28px;font-weight:bold}</style></head><body><h1>Supplier Quality Report</h1><h2>${esc(d.supplier)}</h2><p>Date range: ${esc(f.start||'Beginning')} to ${esc(f.end||'Present')}</p><p>Overall Quality Score</p><div class="score">${d.passRate.toFixed(1)}%</div><p>POs Audited: ${d.rows.length} &nbsp; Passed: ${d.passed} &nbsp; Failed: ${d.rows.length-d.passed}</p><p>Major Defects: ${def.filter(x=>x.type==='Major').length} &nbsp; Minor Defects: ${def.filter(x=>x.type==='Minor').length} &nbsp; Measurement Failures: ${meas.length}</p><h2>Defects</h2><table><tr><th>PO</th><th>Style</th><th>Defect</th><th>Type</th></tr>${def.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.name)}</td><td>${esc(x.type)}</td></tr>`).join('')||'<tr><td colspan="4">None</td></tr>'}</table><h2>Measurement Failures</h2><table><tr><th>PO</th><th>Style</th><th>POM</th><th>Size</th><th>Measured</th><th>Failure</th></tr>${meas.map(x=>`<tr><td>${esc(x.po)}</td><td>${esc(x.style)}</td><td>${esc(x.pom)}</td><td>${esc(x.size)}</td><td>${esc(x.value)}</td><td>${esc(x.status)}</td></tr>`).join('')||'<tr><td colspan="6">None</td></tr>'}</table><p><b>Scoring rule:</b> Overall Quality Score is based exclusively on PO pass rate.</p><script>window.onload=()=>setTimeout(()=>window.print(),250)</script></body></html>`);w.document.close();}
function manager(){
 if(db.user!=='Manager') return `<h2>Manager</h2><p class="muted">Manager settings are available to the Manager only.</p>`;
 return `<h2>Manager</h2><div class="section shared-data-section"><h3>☁ Shared OneDrive / SharePoint Data</h3><p class="muted">Select the <b>OneDrive-synced folder</b> that all auditors will use. The app stores one shared data file there and checks it automatically every 3 seconds. Each computer should select the same shared folder once per session.</p><div class="shared-status-box"><div><b>Status</b><span class="sync-badge ${sharedDirHandle?'live':'offline'}">${esc(sharedStatus)}</span></div><div><b>Shared file</b><span>${SHARED_FILE_NAME}</span></div></div><div class="toolbar"><button type="button" class="primary" id="connectSharedFolder">SELECT SHARED FOLDER</button><button type="button" id="testSharedFolder" ${sharedDirHandle?'':'disabled'}>SYNC NOW</button><button type="button" id="disconnectSharedFolder" ${sharedDirHandle?'':'disabled'}>DISCONNECT</button></div><p class="muted"><b>Important:</b> On each PC, OneDrive must have the company SharePoint folder available offline/synced locally. Do not select a private folder on one computer.</p></div><div class="section"><h3>Auditor Management</h3><p class="muted">Create and manage auditor accounts. Assign each auditor a title, username, and password. Each auditor signs in with their assigned username and password and can only see audits assigned to their own account. Leave a password blank to keep the existing password when editing.</p><form id="auditorForm"><div class="tablewrap"><table><thead><tr><th>#</th><th>Auditor Name</th><th>Title</th><th>Username</th><th>Password</th><th></th></tr></thead><tbody id="auditorRows">${db.auditors.map((n,i)=>{const acc=db.auditorAccounts.find(a=>a.name===n)||{};return `<tr><td>${i+1}</td><td><input class="auditor-name" data-original="${esc(n)}" value="${esc(n)}" required></td><td><input class="auditor-title" value="${esc(acc.title||'Auditor')}" placeholder="e.g. Lead Auditor" required></td><td><input class="auditor-username" value="${esc(acc.username||accountUsername(n))}" required></td><td><input class="auditor-password" type="password" placeholder="Set / change password"></td><td><button type="button" class="danger remove-auditor">REMOVE</button></td></tr>`;}).join('')}</tbody></table></div><div class="toolbar"><button type="button" id="addAuditor">+ ADD AUDITOR</button><button class="primary" type="submit">SAVE AUDITOR ACCOUNTS</button></div></form></div>
 <div class="section"><h3>Manager Login</h3><p class="muted">Manager sign-in credentials are separate from auditor accounts.</p><form id="managerAccountForm"><div class="grid"><label>Manager Username<input id="managerUsername" value="${esc(db.managerAccount?.username||DEFAULT_MANAGER_USERNAME)}" required></label><label>New Manager Password<input id="managerPassword" type="password" placeholder="Leave blank to keep current password"></label></div><button class="primary" type="submit">SAVE MANAGER LOGIN</button></form></div><div class="section"><h3>Supplier Management</h3><p class="muted">Create the supplier list used by Add Audit and maintain each supplier’s Country of Origin (COO).</p><form id="supplierForm"><div class="tablewrap"><table><thead><tr><th>#</th><th>Supplier</th><th>COO</th><th></th></tr></thead><tbody id="supplierRows">${db.suppliers.map((sp,i)=>`<tr><td>${i+1}</td><td><input class="supplier-name" data-original="${esc(sp.name)}" value="${esc(sp.name)}" required></td><td><input class="supplier-coo" value="${esc(sp.coo||'')}" placeholder="Country of origin" required></td><td><button type="button" class="danger remove-supplier">REMOVE</button></td></tr>`).join('')}</tbody></table></div><div class="toolbar"><button type="button" id="addSupplier">+ ADD SUPPLIER</button><button class="primary" type="submit">SAVE SUPPLIER CHANGES</button></div></form></div>
 <div class="section"><h3>Defect List Management</h3><p class="muted">Create the defect list available in the Defect Photos section of every audit.</p><form id="defectForm"><div class="tablewrap"><table><thead><tr><th>#</th><th>Defect</th><th></th></tr></thead><tbody id="defectRows">${db.defectOptions.map((d,i)=>`<tr><td>${i+1}</td><td><input class="defect-option-name" value="${esc(d)}" placeholder="e.g. Broken stitch" required></td><td><button type="button" class="danger remove-defect-option">REMOVE</button></td></tr>`).join('')||'<tr><td colspan="3">No defects configured.</td></tr>'}</tbody></table></div><div class="toolbar"><button type="button" id="addDefectOption">+ ADD DEFECT</button><button class="primary" type="submit">SAVE DEFECT LIST</button></div></form></div>
 <div class="section"><h3>Garment Type / POM Templates</h3><p class="muted">Create reusable measurement templates. Selecting a garment type in an audit automatically loads its POMs. Existing audits keep their saved measurement rows even if a template is later edited.</p><div id="templateEditor"><form id="templateForm"><input type="hidden" name="templateId" value=""><label>Garment Type Name<input name="templateName" placeholder="e.g. Jacket" required></label><div id="templatePomRows" class="template-poms">${templatePomRow()}</div><button type="button" id="templateAddPom">+ ADD POM</button><button class="primary" type="submit">SAVE TEMPLATE</button></form></div><div class="tablewrap"><table><thead><tr><th>Garment Type</th><th>POMs</th><th></th></tr></thead><tbody>${db.garmentTemplates.map(t=>`<tr><td><b>${esc(t.name)}</b></td><td>${t.poms.map(p=>esc(p.pom)).join(', ')}</td><td><button type="button" data-edit-template="${esc(t.id)}">EDIT</button><button type="button" class="danger" data-delete-template="${esc(t.id)}">DELETE</button></td></tr>`).join('')||'<tr><td colspan="3">No templates.</td></tr>'}</tbody></table></div></div>`;
}

function pauseSummary(x){
 const hist=Array.isArray(x.pauseHistory)?x.pauseHistory.slice():[];
 if(x.pauseStarted){const start=new Date(x.pauseStarted);const now=new Date();hist.push({start:x.pauseStarted,end:null,durationMs:Math.max(0,now-start)});}
 if(!hist.length)return '<div><b>Paused</b> No</div><div><b>Paused Time</b> 00:00:00</div>';
 const total=hist.reduce((n,p)=>n+(Number(p.durationMs)||0),0);
 const items=hist.map((p,i)=>`<div><b>Pause ${i+1}</b> ${dt(p.start)}${p.end?` → ${dt(p.end)}`:' → In progress'} <span class="pause-duration">(${duration(p.start,p.end||new Date().toISOString(),0)})</span></div>`).join('');
 return `<div><b>Paused</b> Yes</div><div><b>Total Paused Time</b> ${formatMs(total)}</div><div style="grid-column:1/-1"><b>Pause History</b>${items}</div>`;
}

function printReports(ids){
 let reports=db.audits.filter(x=>ids.includes(x.id) && canViewAudit(x));
 let html=`<!doctype html><html><head><title>DC Quality Audit Reports</title><style>
 body{font-family:Arial,sans-serif;color:#111;margin:30px}.report{page-break-after:always}.report:last-child{page-break-after:auto}
 h1{font-size:22px;margin-bottom:4px}.sub{color:#555;margin-bottom:20px}
 .meta{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aaa}.meta div{padding:8px;border-bottom:1px solid #ddd}.meta b{display:block;font-size:11px;color:#555;text-transform:uppercase}
 table{width:100%;border-collapse:collapse;margin-top:18px;font-size:9px}th,td{border:1px solid #aaa;padding:5px;text-align:left}th{background:#eee}
 .result{font-size:18px;font-weight:bold;margin:18px 0}.auto-result{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:12px 0 18px;border:1px solid #999;padding:10px}.auto-result>div{border:1px solid #ccc;padding:8px;text-align:center;background:#f7f7f7}.auto-result b{display:block;font-size:9px;text-transform:uppercase;color:#555;margin-bottom:5px}.auto-result span,.auto-result strong{font-size:17px}.auto-result .pass{color:#176b2c}.auto-result .fail{color:#a40000}.notes{white-space:pre-wrap;border:1px solid #aaa;padding:12px;min-height:70px}
 .photo-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:10px}.defect-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:10px}
 .photo{border:1px solid #aaa;padding:8px;min-height:260px}.photo img{width:100%;height:230px;object-fit:contain}.caption{font-size:12px;font-weight:bold;margin-bottom:5px}
 .oot-row{}.oot-highlight{background:#fff3a3}.report-measurement-size{margin-top:18px}.report-measurement-size h3{margin:10px 0 6px}.size-note{font-size:11px;color:#666;font-weight:normal}.report-editing{outline:2px dashed #17365d;outline-offset:4px}.report-editing *{cursor:text}.summary-detail{margin-top:14px}.summary-detail th,.summary-detail td{font-size:10px}.toolbar{position:sticky;top:0;background:white;border-bottom:1px solid #ccc;padding:10px;margin:-30px -30px 20px;z-index:10}.toolbar button{padding:10px 16px;font-weight:bold}
 .page{page-break-after:always}.page:last-child{page-break-after:auto}
 @media print{body{margin:12mm}.toolbar{display:none}.page{page-break-after:always}.page:last-child{page-break-after:auto}}
 </style></head><body><div class="toolbar"><button onclick="window.print()">DOWNLOAD / PRINT / SAVE AS PDF</button>${db.user==='Manager'?'<button id="editReportText">EDIT ALL REPORT TEXT</button><button id="lockReportText" style="display:none">FINISH EDITING</button>':''}<button onclick="window.close()">CLOSE</button></div>`;
 html+=reports.map(x=>{
   const rows=x.measurementRows||[]; const count=Math.max(1,parseInt(x.sample||x.aql||1,10)||1);
   const reportSections=Array.isArray(x.measurementSections)&&x.measurementSections.length
     ? x.measurementSections.map(s=>({size:String(s.size||'').trim()||'Unspecified size',count:Math.max(1,parseInt(s.count||1,10)||1),rows:s.rows||[]}))
     : (()=>{const groups=new Map(); const sizes=Array.isArray(x.measurementSizes)?x.measurementSizes:[]; rows.forEach(r=>{const size=String(r.size||sizes[0]||'').trim()||'Unspecified size';if(!groups.has(size))groups.set(size,{size,count:0,rows:[]});const g=groups.get(size);g.count=Math.max(g.count,(r.values||[]).length);g.rows.push(r)}); if(!groups.size && rows.length) groups.set('Unspecified size',{size:'Unspecified size',count:count,rows}); return [...groups.values()]})();
   const mtable=reportSections.length?reportSections.map(sec=>{
     const usedRows=(sec.rows||[]).filter(r=>String(r.pom||r.spec||r.tolMinus||r.tolPlus||'').trim()||((r.values||[]).some(v=>String(v).trim()!=='')));
     if(!usedRows.length)return `<section class="report-measurement-size"><h3>Size: ${esc(sec.size)}</h3><p>No measurements entered for this size.</p></section>`;
     const n=Math.max(1,sec.count||usedRows.reduce((m,r)=>Math.max(m,(r.values||[]).length),0));
     return `<section class="report-measurement-size"><h3>Size: ${esc(sec.size)} <span class="size-note">(${n} garment${n===1?'':'s'} sampled)</span></h3><table><thead><tr><th>POM</th><th>Spec</th><th>Tol. -</th><th>Tol. +</th>${Array.from({length:n},(_,i)=>`<th>Garment ${i+1}<br>Measurement</th><th>OOT?</th><th>OOT By</th>`).join('')}</tr></thead><tbody>${usedRows.map(r=>`<tr><td>${esc(r.pom||'')}</td><td>${esc(r.spec||'')}</td><td>${esc(r.tolMinus||'')}</td><td>${esc(r.tolPlus||'')}</td>${Array.from({length:n},(_,i)=>{const val=(r.values||[])[i]||'';const st=measurementStatus(r.spec,r.tolMinus,r.tolPlus,val);return `<td class="${val&&st.status.startsWith('OUT')?'oot-highlight':''}">${esc(val)}</td><td class="${val&&st.status.startsWith('OUT')?'oot-highlight':''}">${val?st.status:'—'}</td><td class="${val&&st.status.startsWith('OUT')?'oot-highlight':''}">${val&&st.status.startsWith('OUT')?st.variance:'—'}</td>`}).join('')}</tr>`).join('')}</tbody></table></section>`;
   }).join(''):'<p>No measurements entered.</p>';
   const p=x.photos||{};
   const photoKeys=[['front','Front'],['back','Back'],['side','Side View'],['special1','Special Part 1'],['special2','Special Part 2'],['label1','Label 1'],['label2','Label 2'],['label3','Label 3'],...Object.keys(p).filter(k=>!['front','back','side','special1','special2','label1','label2','label3'].includes(k)).map((k,i)=>[k,p[k]?.label||`Garment Photo ${i+9}`])];
   const usedPhotos=photoKeys.filter(([k])=>p[k]?.image); const photos=usedPhotos.length?`<div class="photo-grid">${usedPhotos.map(([k,l])=>`<div class="photo"><div class="caption">${l}</div><img src="${p[k].image}"></div>`).join('')}</div>`:'<p class="muted">No garment photos entered.</p>';
   const dp=x.defectPhotos||[];
   const usedDefects=dp.filter(d=>d?.image||String(d?.label||'').trim()); const defects=usedDefects.length?`<div class="defect-grid">${usedDefects.map((d,i)=>`<div class="photo"><div class="caption">${d.label?`Defect: ${esc(d.label)}`:`Defect ${i+1}`}${d.type?` — ${esc(d.type)}`:''}</div>${d.image?`<img src="${d.image}">`:`<div class="textonly">${esc(d.label||'Defect documented without photo')}</div>`}</div>`).join('')}</div>`:'<p class="muted">No defect photos or labels entered.</p>';
   return `<section class="report" ${db.user==='Manager'?'data-manager-editable="true"':''}>
   <div class="page"><h1>DC Quality Audit Report</h1><div class="meta"><div><b>PO #</b>${esc(x.po)}</div><div><b>Style</b>${esc(x.style)}</div><div><b>Supplier</b>${esc(x.supplier)}</div><div><b>Shipment #</b>${esc(x.shipmentNumber||'—')}</div><div><b>Shipment PO</b>${x.shipmentSeq&&x.shipmentTotal?esc(`${x.shipmentSeq}/${x.shipmentTotal}`):'—'}</div><div><b>Garment Type</b>${esc(x.garmentTypeName||'—')}</div><div><b>Size Range</b>${esc(x.sizeRange||'—')}</div><div><b>Sizes Inspected</b>${esc(x.sizesInspected||'—')}</div><div><b>Color</b>${esc(x.color||'—')}</div><div><b>COO</b>${esc(x.coo||'—')}</div><div style="grid-column:1/-1"><b>Garment Style Description</b>${esc(x.description||'—')}</div><div><b>Quantity</b>${esc(x.qty)}</div><div><b>Auditor</b>${esc(x.assigned)}</div><div><b>Auditor Title</b>${esc(x.assigned?auditorTitle(x.assigned):'—')}</div><div><b>Audit Started</b>${dt(x.start)}</div><div><b>Completed</b>${dt(x.complete)}</div><div><b>Total Audit Time</b>${duration(x.start,x.complete,x.pausedMs)}</div>${pauseSummary(x)}<div><b>Priority</b>${esc(x.priority)}</div><div><b>AQL Sample</b>${esc(x.sample||x.aql||'—')}</div><div><b>Defects Found</b>${esc(x.defects||0)}</div><div><b>Major Defects</b>${esc((x.defectPhotos||[]).filter(d=>d&&(d.image||String(d.label||'').trim())&&d.type==='Major').length)}</div><div><b>Minor Defects</b>${esc((x.defectPhotos||[]).filter(d=>d&&(d.image||String(d.label||'').trim())&&d.type==='Minor').length)}</div><div><b>Max Allowable Major Defects</b>${esc(defectAcceptance(x).allowed===null?'—':defectAcceptance(x).allowed)}</div><div><b>Effective Major Defects</b>${esc(defectAcceptance(x).effective.toFixed(2))}</div><div><b>Defect Check</b>${esc(defectAcceptance(x).label)}</div><div><b>Reinspection</b>${esc(x.reinspect||'No')}</div></div><div class="result">Result: ${esc(x.result||'—')}</div><div class="auto-result"><div><b>Auto Pass / Fail</b><strong class="${(auditPomStats(x).pass&&defectAcceptance(x).pass)?'pass':'fail'}">${(auditPomStats(x).pass&&defectAcceptance(x).pass)?'PASS':'FAIL'}</strong></div><div><b>Total Measurements</b><span>${auditPomStats(x).totalMeasurements}</span></div><div><b>Measurements OOT −</b><span>${auditPomStats(x).outMinus}</span></div><div><b>Measurements OOT +</b><span>${auditPomStats(x).outPlus}</span></div><div><b>Total OOT Measurements</b><span>${auditPomStats(x).totalOOTMeasurements}</span></div><div><b>Max Allowed OOT Measurements</b><span>${auditPomStats(x).allowed}</span></div></div><div class="audit-summary"><h2>Audit Summary Chart</h2><p class="summary-subtitle">Summary of POM measurements entered for this audit only.</p>${summaryHtml(x)}</div><h2>Measurements</h2>${mtable}</div>
   <div class="page"><h2>Garment Photos</h2><p>Standard garment documentation.</p>${photos}</div>
   <div class="page"><h2>Defect Photos</h2>${defects}</div>
   <div class="page"><h2>Audit Notes</h2><div class="notes">${esc(x.notes||'')}</div></div>
   </section>`;
 }).join('');
 html+=`<script>
document.addEventListener('DOMContentLoaded',()=>{
 const reports=[...document.querySelectorAll('.report[data-manager-editable]')];
 const edit=document.getElementById('editReportText'), lock=document.getElementById('lockReportText');
 if(edit&&reports.length){
   edit.onclick=()=>{reports.forEach(r=>{r.contentEditable='true';r.classList.add('report-editing');});edit.style.display='none';if(lock)lock.style.display='inline-block';};
   if(lock)lock.onclick=()=>{reports.forEach(r=>{r.contentEditable='false';r.classList.remove('report-editing');});lock.style.display='none';edit.style.display='inline-block';};
 }
});
</script></body></html>`;
 const w=window.open('','_blank'); if(!w){alert('Please allow pop-ups for the audit report.');return} w.document.write(html);w.document.close();
}

function closeModal(){let m=document.getElementById('modal');m.className='hidden';m.innerHTML=''}
async function bootstrap(){ if(!db.managerAccount.passwordHash) db.managerAccount.passwordHash=await hashPassword(DEFAULT_MANAGER_PASSWORD); migrateAccounts(); if(!db.auditorAccounts.every(a=>a.passwordHash)){} authReady=!!authenticatedUser && (authenticatedUser==='Manager'||db.auditorAccounts.some(a=>a.name===authenticatedUser)); if(!authReady) authenticatedUser=''; db.user=authReady?authenticatedUser:''; localStorage.setItem(KEY,JSON.stringify(db)); nav(); render(); initSharedSync(); }
bootstrap();
