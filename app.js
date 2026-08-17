"use strict";
/* ---------- state ---------- */
let S = {
  started:false, teams:10, slot:5, rounds:15, req:{...DEF_REQ},
  pick:1,                    // current overall pick about to be made
  actions:[],                // [{id, kind:'taken'|'mine', pick}]
  queue:[],                  // starred player ids, in priority order
  split:.5,                  // two-pane splitter fraction, clamped .22-.82
  pane:null,                 // null (split) | 'main' | 'side' — maximized pane
  notes:[],                  // [{id, text, pinned, stamp}]
  sideOrder:['needs','flow','reset','trend','notes'],
  teamNames:{},               // {teamNumber: 'Custom Name'} — set from Settings after the live draft
  ui:{tab:'draft', pos:'ALL', search:'', hideDrafted:true, shown:50, cmp:[], cmpActive:false,
    logSort:'desc', logQ:'', logPos:'ALL', logTeam:'ALL', hotTakes:false}
};
function teamLabel(n, short){
  const custom = S.teamNames && S.teamNames[n];
  if(custom) return custom;
  return short ? ('T'+n) : ('Team '+n);
}
const status = {};           // id -> 'taken' | 'mine'
/* ---------- sleeper enrichment (live injury/depth data + photo ids) ---------- */
let ENRICH = {};             // id -> {sleeper_id, injury_status, depth_chart_position, depth_chart_order, years_exp}
let enrichLoaded = false;
async function loadEnrichment(){
  const badge = document.getElementById('enrichBadge');
  if(badge) badge.textContent = '· syncing live data…';
  try{
    const res = await fetch('/api/players');
    if(!res.ok) throw new Error('bad status '+res.status);
    const data = await res.json();
    ENRICH = data.players || {};
    // Live ADP feeds the value calc (and the ADP number shown in the UI) for
    // players FFC has real draft volume on. Tiers and positional rank (pr)
    // are computed/curated separately and are never touched here.
    for(const p of PLAYERS){
      const e = ENRICH[p.id];
      if(e && typeof e.live_adp === 'number'){
        if(p._consensusAdp === undefined) p._consensusAdp = p.adp;
        p.adp = e.live_adp;
      }
    }
    if(badge) badge.textContent = '· live data synced';
  }catch(e){
    console.warn('Live player data unavailable — falling back to consensus rankings only.', e);
    ENRICH = {};
    if(badge) badge.textContent = '· live data unavailable (using consensus rankings)';
  }finally{
    enrichLoaded = true;
    if(badge) setTimeout(()=>{ if(badge.textContent.includes('synced')) badge.textContent=''; }, 4000);
    if(S.started) renderAll();
  }
}
loadEnrichment();
/* ---------- cloud sync (Supabase) ---------- */
const cloudConfigured = typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL && !/YOUR-PROJECT/.test(SUPABASE_URL);
const sb = cloudConfigured ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
let cloudUser = null;
let cloudReady = false;   // true once the initial cloud load/restore attempt has finished
let saveTimer = null;
function scheduleCloudSave(){
  if(!sb || !cloudUser || !cloudReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToCloud, 900);
}
async function saveToCloud(){
  if(!sb || !cloudUser) return;
  try{
    await sb.from('app_state').upsert({
      user_id: cloudUser.id,
      draft_state: {...S, ui:undefined},
      updated_at: new Date().toISOString(),
    });
  }catch(e){ console.warn('Cloud save failed', e); }
}
async function loadFromCloud(){
  if(!sb || !cloudUser) return;
  try{
    const {data, error} = await sb.from('app_state').select('draft_state, notes').eq('user_id', cloudUser.id).maybeSingle();
    if(error) throw error;
    if(data){
      if(data.draft_state && Array.isArray(data.draft_state.actions)){
        S = {...S, ...data.draft_state, ui:S.ui};
        rebuildStatus();
      }
      // one-time migration: fold any legacy freeform-text note into the new structured list
      if((!S.notes || !S.notes.length) && data.notes){
        S.notes=[{id:'legacy', text:data.notes, pinned:false, stamp:'—'}];
      }
      if(!S.sideOrder || !S.sideOrder.length) S.sideOrder=['needs','flow','reset','trend','notes'];
    }
  }catch(e){ console.warn('Cloud load failed', e); }
}
function updateAuthBtn(){
  const btn=$('authBtn');
  if(!cloudConfigured || !cloudUser){ btn.style.display='none'; return; }
  btn.style.display='inline-flex';
  btn.title = `Signed in as ${cloudUser.email} — tap to sign out`;
}
function showAuthView(){
  $('authView').style.display='block';
  $('setupView').style.display='none';
  $('statusbar').style.display='none'; $('tabsScroll').style.display='none';
  $('bottombar').style.display='none'; $('chatbar').style.display='none';
  $('wrap').classList.remove('two-pane');
  $('authBtn').style.display='none';
}
async function onSignedIn(user){
  cloudUser = user;
  $('authView').style.display='none';
  updateAuthBtn();
  await loadFromCloud();
  cloudReady = true;
  if(S.started){ showApp(); renderAll(); }
  else { $('setupView').style.display='block'; }
}
function initCloudAuth(){
  if(!cloudConfigured){ cloudReady = true; return; }
  $('setupView').style.display='none';
  sb.auth.getSession().then(({data})=>{
    if(data.session) onSignedIn(data.session.user);
    else showAuthView();
  });
  sb.auth.onAuthStateChange((event)=>{
    if(event==='SIGNED_OUT'){ cloudUser=null; cloudReady=false; }
  });
  let authMode='signin';
  $('authToggle').onclick=(e)=>{
    e.preventDefault();
    authMode = authMode==='signin' ? 'signup' : 'signin';
    $('authSubmit').textContent = authMode==='signin' ? 'Sign in' : 'Create account';
    $('authTitle').textContent = authMode==='signin' ? 'Sign in' : 'Create account';
    $('authToggle').textContent = authMode==='signin' ? 'Need an account? Sign up' : 'Have an account? Sign in';
    $('authMsg').textContent='';
  };
  $('authSubmit').onclick=async()=>{
    const email=$('authEmail').value.trim(); const password=$('authPassword').value;
    if(!email||!password){ $('authMsg').textContent='Enter email and password.'; return; }
    $('authSubmit').disabled=true; $('authMsg').textContent='';
    try{
      const {data, error} = authMode==='signin'
        ? await sb.auth.signInWithPassword({email,password})
        : await sb.auth.signUp({email,password});
      if(error) throw error;
      if(authMode==='signup' && !data.session){
        $('authMsg').style.color='var(--me)';
        $('authMsg').textContent='Account created — check your email to confirm, then sign in.';
        return;
      }
      await onSignedIn(data.session.user);
    }catch(e){
      $('authMsg').style.color='var(--warn)';
      $('authMsg').textContent = e.message || 'Something went wrong.';
    }finally{
      $('authSubmit').disabled=false;
    }
  };
  $('authBtn').onclick=async()=>{
    if(!confirm('Sign out?')) return;
    await sb.auth.signOut();
    location.reload();
  };
}
/* ---------- avatars & team logos ---------- */
function initials(name){
  const parts=(name||'').replace(/[^a-zA-Z' -]/g,'').split(/\s+/).filter(Boolean);
  if(!parts.length) return '?';
  const first=parts[0][0]||''; const last=parts.length>1?parts[parts.length-1][0]:'';
  return (first+last).toUpperCase();
}
function avatarHtml(p, size){
  const color=TEAM_COLORS[p.t]||TEAM_COLORS.FA;
  const fb=`<div class="avatar-fallback" style="background:${color}">${initials(p.n)}</div>`;
  const e=ENRICH[p.id];
  const hasImg=e&&e.sleeper_id;
  const cls='avatar-wrap'+(size?' '+size:'')+(hasImg?' loading':'');
  const img=hasImg
    ? `<img class="avatar-img" src="https://sleepercdn.com/content/nfl/players/${e.sleeper_id}.jpg" loading="lazy"
        onload="this.classList.add('loaded'); this.parentElement.classList.remove('loading')"
        onerror="this.style.display='none'; this.parentElement.classList.remove('loading')">`
    : '';
  return `<div class="${cls}" style="--ring:${color}">${fb}${img}</div>`;
}
const ADP_TOOLTIP='Consensus ranking, manually compiled July 2026 — not a live feed.';
const LIVE_ADP_TOOLTIP='Live ADP from real drafts, updated daily (Fantasy Football Calculator). Tier and positional rank stay on the curated consensus.';
function adpTooltip(id){ const e=ENRICH[id]; return (e && typeof e.live_adp==='number') ? LIVE_ADP_TOOLTIP : ADP_TOOLTIP; }
const INJURY_LABELS={Q:'Questionable', D:'Doubtful', O:'Out', IR:'Injured Reserve', PUP:'PUP', SUSP:'Suspended', NA:'Not Active'};
function injuryBadgeHtml(id){
  const e=ENRICH[id];
  if(!e||!e.injury_status) return '';
  return ` <span class="injbadge ${e.injury_status}" title="${INJURY_LABELS[e.injury_status]||e.injury_status}">${e.injury_status}</span>`;
}
function teamLogoHtml(team){
  if(!team||team==='FA') return '';
  const color=TEAM_COLORS[team]||TEAM_COLORS.FA;
  return `<span class="logo-wrap loading" style="background:${color}"><span class="logo-fallback">${team}</span><img class="logo-img" src="https://a.espncdn.com/i/teamlogos/nfl/500/${team}.png" loading="lazy"
      onload="this.classList.add('loaded'); this.parentElement.classList.remove('loading')"
      onerror="this.style.display='none'; this.parentElement.classList.remove('loading')"></span>`;
}
/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const posColor = p => `pos-${p}`;
function toast(msg){ const t=$('toast'); t.textContent=msg; t.style.display='block';
  clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none', 1800); }
function rebuildStatus(){ for(const k in status) delete status[k];
  for(const a of S.actions) status[a.id]=a.kind; }
function inQueue(id){ return S.queue.includes(id); }
function toggleStar(id){
  const i=S.queue.indexOf(id);
  if(i>=0){ S.queue.splice(i,1); toast('Removed from queue'); }
  else { S.queue.push(id); const p=PLAYERS.find(x=>x.id===id); toast(`★ ${p.n} queued`); }
  renderAll();
}
function starButton(id){
  const b=document.createElement('button');
  b.className='starbtn'+(inQueue(id)?' on':'');
  b.textContent=inQueue(id)?'★':'☆';
  b.onclick=e=>{ e.stopPropagation(); toggleStar(id); };
  return b;
}
function roundOf(pick){ return Math.floor((pick-1)/S.teams)+1; }
function pickInRound(pick){ return ((pick-1)%S.teams)+1; }
function teamOnClock(pick){ const r=roundOf(pick), p=pickInRound(pick);
  return (r%2===1) ? p : S.teams-p+1; }
function myPickNumbers(){ const out=[];
  for(let r=1;r<=S.rounds;r++){ const p=(r%2===1)?S.slot:S.teams-S.slot+1; out.push((r-1)*S.teams+p); }
  return out; }
function nextMyPicks(n){ return myPickNumbers().filter(x=>x>=S.pick).slice(0,n); }
function totalPicks(){ return S.teams*S.rounds; }
function pickForRoundTeam(r,t){ const p=(r%2===1)?t:(S.teams-t+1); return (r-1)*S.teams+p; }
/* ---------- tiers (ADP-gap based, per position) ---------- */
const tiers = {};
(function(){
  const byPos = {};
  for(const p of PLAYERS) (byPos[p.p]=byPos[p.p]||[]).push(p);
  for(const pos in byPos){
    const list = byPos[pos].sort((a,b)=>a.adp-b.adp);
    let t=1;
    tiers[list[0].id]=1;
    for(let i=1;i<list.length;i++){
      const gap=list[i].adp-list[i-1].adp;
      const thresh=Math.max(5, list[i-1].adp*0.13);
      if(gap>=thresh && t<12) t++;
      tiers[list[i].id]=t;
    }
  }
})();
/* ---------- my roster assembly ---------- */
function myRoster(){
  const picks = S.actions.filter(a=>a.kind==='mine')
    .map(a=>({...PLAYERS.find(p=>p.id===a.id), pickNo:a.pick}));
  const slots = [];
  for(const pos of ['QB','RB','WR','TE','FLEX','K','DST'])
    for(let i=0;i<(S.req[pos]||0);i++) slots.push({lab:pos+(S.req[pos]>1?' '+(i+1):''), pos, pl:null});
  for(let i=0;i<(S.req.BN||0);i++) slots.push({lab:'BN '+(i+1), pos:'BN', pl:null});
  const flexOK = p=>['RB','WR','TE'].includes(p);
  for(const pl of picks){
    let s = slots.find(x=>!x.pl && x.pos===pl.p)
         || (flexOK(pl.p) && slots.find(x=>!x.pl && x.pos==='FLEX'))
         || slots.find(x=>!x.pl && x.pos==='BN');
    if(s) s.pl=pl;
  }
  return {picks, slots};
}
function openStarters(){
  const {slots} = myRoster(); const need={};
  for(const s of slots) if(!s.pl && s.pos!=='BN') need[s.pos]=(need[s.pos]||0)+1;
  return need;   // e.g. {RB:1, FLEX:1, K:1, DST:1}
}
/* ---------- recommendation engine ---------- */
function scoreAvailable(){
  const need = openStarters();
  const {picks} = myRoster();
  const myCount = {}; for(const p of picks) myCount[p.p]=(myCount[p.p]||0)+1;
  const myPicksLeft = nextMyPicks(1e9).length;
  const kdNeeded = (need.K||0)+(need.DST||0);
  const nxt = nextMyPicks(2);
  const afterThis = nxt.length>1 ? nxt[1] : totalPicks();
  // recent positional run (last 12 picks)
  const recent = S.actions.slice(-12); const runCount={};
  for(const a of recent){ const pl=PLAYERS.find(p=>p.id===a.id); runCount[pl.p]=(runCount[pl.p]||0)+1; }
  // tier remaining counts
  const tierLeft = {};
  for(const p of PLAYERS) if(!status[p.id]){
    const key=p.p+'-'+tiers[p.id]; tierLeft[key]=(tierLeft[key]||0)+1; }
  const myByes = {}; for(const p of picks) if(p.b) myByes[p.b]=(myByes[p.b]||0)+1;
  const scored=[];
  for(const p of PLAYERS){
    if(status[p.id]) continue;
    const reasons=[];
    let base = Math.max(0, 320 - p.adp);
    // need weight
    let w;
    if(need[p.p]) { w=1.0; reasons.push({t:`Starting ${p.p} open`, c:'good'}); }
    else if(need.FLEX && ['RB','WR','TE'].includes(p.p)) { w=0.88; reasons.push({t:'Fills FLEX', c:'good'}); }
    else if(p.p==='QB'||p.p==='TE') { w=(myCount[p.p]>=2)?0.12:0.3; }
    else if(p.p==='K'||p.p==='DST') { w=0.02; }
    else { w = (myCount[p.p]||0) <= 3 ? 0.62 : 0.42; reasons.push({t:'Bench depth', c:''}); }
    // K/DST end-game logic
    if(p.p==='K'||p.p==='DST'){
      if(kdNeeded>0 && myPicksLeft<=kdNeeded+1){ w=1.5; reasons.push({t:'Time to fill '+p.p, c:'urgent'}); }
      else if(kdNeeded===0){ w=0.01; }
    }
    let score = base*w;
    // ADP value
    if(p.adp < S.pick - 3){
      const v=Math.min(25,(S.pick-p.adp)*0.6); score+=v;
      reasons.push({t:`Value — ADP ${p.adp}, now pick ${S.pick}`, c:'good'});
    }
    // tier cliff
    const left = tierLeft[p.p+'-'+tiers[p.id]];
    if(left<=2 && tiers[p.id]<=7 && ['RB','WR','TE','QB'].includes(p.p)){
      score+=16; reasons.push({t:`Tier ${tiers[p.id]} ${p.p} — ${left} left`, c:'urgent'});
    }
    // positional run
    if((runCount[p.p]||0)>=4 && ['RB','WR'].includes(p.p)){
      score+=8; reasons.push({t:`${p.p} run (${runCount[p.p]} of last 12)`, c:'urgent'});
    }
    // won't make it back
    if(p.adp <= afterThis && S.pick < totalPicks()-S.teams){
      reasons.push({t:`Likely gone before your next pick (#${afterThis})`, c:'gone'});
    }
    // user's queue
    if(inQueue(p.id)){ score+=6; reasons.unshift({t:'★ In your queue', c:'good'}); }
    // bye stacking (soft)
    if(p.b && (myByes[p.b]||0)>=3){ score-=5; reasons.push({t:`Bye ${p.b} pile-up`, c:''}); }
    scored.push({p, score, reasons});
  }
  scored.sort((a,b)=>b.score-a.score);
  return scored;
}
function recommend(n=5){ return scoreAvailable().slice(0,n); }
/* ---------- rendering ---------- */
function fillSelect(sel, from, to, cur){ sel.innerHTML='';
  for(let i=from;i<=to;i++){ const o=document.createElement('option'); o.value=i; o.textContent=i;
    if(i===cur)o.selected=true; sel.appendChild(o);} }
function reqEditor(container, req){
  container.innerHTML='';
  for(const k of ['QB','RB','WR','TE','FLEX','K','DST','BN']){
    const d=document.createElement('div'); d.className='reqitem';
    d.innerHTML=`<div class="lab">${k}</div><div class="stepper">
      <button data-k="${k}" data-d="-1">−</button><span class="num" id="req-${container.id}-${k}">${req[k]}</span>
      <button data-k="${k}" data-d="1">+</button></div>`;
    container.appendChild(d);
  }
  container.onclick=e=>{
    const b=e.target.closest('button'); if(!b)return;
    const k=b.dataset.k; req[k]=Math.max(0, Math.min(9, req[k]+Number(b.dataset.d)));
    $(`req-${container.id}-${k}`).textContent=req[k];
  };
}
function renderStatus(){
  const done = S.pick > totalPicks();
  $('stRound').textContent = done ? '✓' : roundOf(S.pick);
  $('stPick').textContent = done ? 'End' : `${S.pick}`;
  const mine = !done && teamOnClock(S.pick)===S.slot;
  $('stClockBox').classList.toggle('onclock', mine);
  $('stClock').textContent = done ? '—' : (mine ? 'YOU' : teamLabel(teamOnClock(S.pick)));
  $('stClockLab').textContent = mine ? 'Your pick!' : 'On the clock';
  const nxt = nextMyPicks(1);
  $('stNext').textContent = !nxt.length ? '—' : (nxt[0]===S.pick ? 'Now' : nxt[0]-S.pick);
  $('subhdr').textContent = `${S.teams}-team PPR snake · slot ${S.slot} · Rd ${Math.min(roundOf(Math.min(S.pick,totalPicks())),S.rounds)}/${S.rounds}`;
}
function pcardInfoHtml(p, opts){
  opts=opts||{};
  const bye = p.b ? `Bye ${p.b}` : 'FA';
  const chipsHtml = opts.chips ? `<div class="pcard-chips">${opts.chips}</div>` : '';
  return `<div class="pcard-name">${p.n}${opts.nameExtra||''}${injuryBadgeHtml(p.id)}</div>
    <div class="pcard-meta"><span class="posbadge ${posColor(p.p)}">${p.p}${p.pr}</span>${teamLogoHtml(p.t)}${p.t} · ${bye} · <span title="${adpTooltip(p.id)}">ADP ${p.adp}</span> · <span class="tierb">Tier ${tiers[p.id]}</span></div>
    ${chipsHtml}`;
}
function queueStarHtml(id){ return inQueue(id) ? ' <span style="color:var(--queue)">★</span>' : ''; }
function playerRow(p){
  const st = status[p.id];
  const row=document.createElement('div');
  row.className='pcard rowrail'+(st==='taken'?' gone':'')+(st==='mine'?' mine':'')
    +(S.ui.cmp.includes(p.id)?' cmpsel':'');
  row.style.borderLeftColor = TEAM_COLORS[p.t]||TEAM_COLORS.FA;
  row.innerHTML=`<div class="pcard-top">
      <div class="pcard-rank">${p.id}</div>
      ${avatarHtml(p,'sm')}
      <div class="pcard-info">${pcardInfoHtml(p,{nameExtra:queueStarHtml(p.id)})}</div>
    </div>
    <div class="pcard-actions"></div>`;
  row.querySelector('.pcard-info').onclick=()=>{
    if(S.ui.cmpActive) toggleCompare(p.id); else openPlayer(p.id); };
  const actions=row.querySelector('.pcard-actions');
  if(!st){
    actions.appendChild(starButton(p.id));
    const b1=document.createElement('button'); b1.className='btn taken'; b1.textContent='Taken';
    b1.onclick=()=>mark(p.id,'taken');
    const b2=document.createElement('button'); b2.className='btn mine'; b2.textContent='Me';
    b2.onclick=()=>mark(p.id,'mine');
    actions.appendChild(b1); actions.appendChild(b2);
  } else {
    const tag=document.createElement('div'); tag.className='pcard-tag';
    tag.style.color = st==='mine' ? 'var(--me)' : 'var(--bad)';
    const a=S.actions.find(x=>x.id===p.id);
    tag.textContent=(st==='mine'?'MINE':'GONE')+(a?` · pick #${a.pick}`:'');
    actions.appendChild(tag);
  }
  return row;
}
function renderRecs(){
  const el=$('recs'); el.innerHTML='';
  const mine = S.pick<=totalPicks() && teamOnClock(S.pick)===S.slot;
  $('recsSection').style.display = mine ? 'block' : 'none';
  if(!mine) return;
  $('recHdr').innerHTML = `<span class="dd-pulse" style="display:inline-block">RECOMMENDED NOW</span> <span style="float:right; color:var(--dim); text-transform:none; letter-spacing:0">pick #${S.pick}</span>`;
  const recs=recommend(2);
  recs.forEach((r,i)=>{
    const d=document.createElement('div'); d.className='pcard top';
    const chips=r.reasons.slice(0,3).map(x=>`<span class="chip ${x.c}">${x.t}</span>`).join('');
    d.innerHTML=`<div class="pcard-top">
        <div class="pcard-rank">${i+1}</div>
        ${avatarHtml(r.p,'md')}
        <div class="pcard-info">${pcardInfoHtml(r.p,{nameExtra:queueStarHtml(r.p.id), chips})}</div>
      </div>
      <div class="pcard-actions"></div>`;
    d.querySelector('.pcard-info').onclick=()=>openPlayer(r.p.id);
    const actions=d.querySelector('.pcard-actions');
    actions.appendChild(starButton(r.p.id));
    const b1=document.createElement('button'); b1.className='btn taken'; b1.style.height='44px'; b1.textContent='Taken';
    b1.onclick=()=>mark(r.p.id,'taken');
    const b2=document.createElement('button'); b2.className='btn mine'; b2.style.height='44px'; b2.textContent='Draft to my team';
    b2.onclick=()=>mark(r.p.id,'mine');
    actions.appendChild(b1); actions.appendChild(b2);
    el.appendChild(d);
  });
}
function renderBuddyLatest(){
  const strip=$('buddyLatest'); if(!strip) return;
  const lastReply=[...chatHistory].reverse().find(m=>m.role==='assistant' && m.content && !m.errored);
  if(!lastReply){ strip.style.display='none'; return; }
  strip.style.display='flex';
  $('blText').textContent=lastReply.content.split('\n')[0].slice(0,140);
}
function renderBoard(){
  const el=$('board'); el.innerHTML='';
  const q=S.ui.search.toLowerCase();
  let list=PLAYERS.filter(p=>{
    if(S.ui.hideDrafted && status[p.id]) return false;
    if(S.ui.pos==='ALL'){}
    else if(S.ui.pos==='FLEX'){ if(!['RB','WR','TE'].includes(p.p)) return false; }
    else if(p.p!==S.ui.pos) return false;
    if(q && !(p.n.toLowerCase().includes(q)||p.t.toLowerCase().includes(q))) return false;
    return true;
  });
  const shown=list.slice(0,S.ui.shown);
  if(!list.length){
    const q2=S.ui.search;
    el.innerHTML=`<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">${q2?`No players match "${q2}"`:'No players match your filters'}</div>
        <div class="empty-sub">${S.ui.hideDrafted?'Try showing drafted players, or clear the search/position filter.':'Try a different search or position filter.'}</div>
      </div>`;
  } else {
    for(const p of shown) el.appendChild(playerRow(p));
  }
  $('showMore').style.display = list.length>S.ui.shown ? 'block':'none';
}
function renderQueue(){
  const el=$('queueList'); el.innerHTML='';
  if(!S.queue.length){
    el.innerHTML=`<div class="empty-state">
        <div class="empty-icon">☆</div>
        <div class="empty-title">Your queue is empty</div>
        <div class="empty-sub">Star players from the Draft tab while you wait for your turn.</div>
      </div>`;
    $('clearGone').style.display='none'; return;
  }
  let nextFound=false, anyGone=false;
  S.queue.forEach((id,i)=>{
    const p=PLAYERS.find(x=>x.id===id);
    const st=status[id];
    const isNext = !st && !nextFound; if(isNext) nextFound=true;
    if(st) anyGone=true;
    const d=document.createElement('div');
    d.className='pcard'+(isNext?' next':'')+(st?' crossed gone':'');
    const nameExtra=isNext?' <span class="nextup">NEXT UP</span>':'';
    d.innerHTML=`<div class="pcard-top">
        <div class="qord">
          <button data-d="-1" ${i===0?'disabled':''}>▲</button>
          <button data-d="1" ${i===S.queue.length-1?'disabled':''}>▼</button>
        </div>
        <div class="pcard-rank">${i+1}</div>
        ${avatarHtml(p,'sm')}
        <div class="pcard-info">${pcardInfoHtml(p,{nameExtra})}</div>
      </div>
      <div class="pcard-actions"></div>`;
    d.querySelector('.pcard-info').onclick=()=>openPlayer(id);
    d.querySelector('.qord').onclick=e=>{
      const b=e.target.closest('button'); if(!b||b.disabled)return;
      const j=i+Number(b.dataset.d);
      [S.queue[i],S.queue[j]]=[S.queue[j],S.queue[i]]; renderQueue(); scheduleCloudSave();
    };
    const actions=d.querySelector('.pcard-actions');
    if(!st){
      const b1=document.createElement('button'); b1.className='btn taken'; b1.textContent='Taken';
      b1.onclick=()=>mark(id,'taken');
      const b2=document.createElement('button'); b2.className='btn mine'; b2.textContent='Me';
      b2.onclick=()=>mark(id,'mine');
      actions.appendChild(b1); actions.appendChild(b2);
    } else {
      const tag=document.createElement('div'); tag.className='pcard-tag';
      tag.style.color = st==='mine' ? 'var(--me)' : 'var(--bad)';
      tag.textContent = st==='mine' ? 'MINE' : 'GONE';
      actions.appendChild(tag);
    }
    const x=document.createElement('button'); x.className='qx'; x.textContent='✕';
    x.onclick=()=>{ S.queue.splice(i,1); renderAll(); };
    actions.appendChild(x);
    el.appendChild(d);
  });
  $('clearGone').style.display = anyGone ? 'block':'none';
}
$('clearGone').onclick=()=>{ S.queue=S.queue.filter(id=>!status[id]); renderAll(); };
function openPlayer(id){
  const p=PLAYERS.find(x=>x.id===id);
  const st=status[id]; const s=STATS[String(id)];
  const e=ENRICH[id];
  const sheet=$('pSheet');
  const bye=p.b?`Bye ${p.b}`:'Free agent';
  let statsHtml;
  if(s){
    const fppg=(s.fp/s.g).toFixed(1);
    statsHtml=`<h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);margin:16px 2px 6px">2025 season (PPR)</h2>
      <div class="pd-facts" style="grid-template-columns:repeat(3,1fr); margin:8px 0 0">
        <div class="fact"><div class="v">${s.fp.toFixed(1)}</div><div class="l">Fantasy pts</div></div>
        <div class="fact"><div class="v">${fppg}</div><div class="l">Pts / game</div></div>
        <div class="fact"><div class="v">${s.g}</div><div class="l">Games</div></div>
      </div>
      <div class="pd-stats">${s.rows.map(r=>`<div class="fact"><div class="v">${r[1]}</div><div class="l">${r[0]}</div></div>`).join('')}</div>`;
  } else {
    statsHtml=`<div class="pd-none">No 2025 NFL stats — rookie (2026 draft class) or missed last season.</div>`;
  }
  let injuryHtml='';
  if(e){
    const injV = e.injury_status
      ? `<span class="injbadge ${e.injury_status}" style="font-size:14px;padding:2px 9px">${e.injury_status}</span>`
      : '✓ Active';
    const depthV = (e.depth_chart_position && e.depth_chart_order) ? `${e.depth_chart_position} · #${e.depth_chart_order}` : '—';
    injuryHtml=`<div class="pd-facts" style="grid-template-columns:1fr 1fr; margin-top:10px">
        <div class="fact"><div class="v">${injV}</div><div class="l">Injury status</div></div>
        <div class="fact"><div class="v">${depthV}</div><div class="l">Depth chart</div></div>
      </div>`;
  }
  sheet.innerHTML=`<div class="pd-head">
      ${avatarHtml(p,'lg')}
      <div style="flex:1">
        <div class="pd-name">${p.n}${injuryBadgeHtml(id)}</div>
        <div class="pd-sub"><span class="posbadge ${posColor(p.p)}">${p.p}${p.pr}</span>${teamLogoHtml(p.t)}${p.t} · ${bye}</div>
      </div>
      <button class="iconbtn" id="pdClose">✕</button>
    </div>
    <div class="pd-facts">
      <div class="fact"><div class="v">#${p.id}</div><div class="l">Rank</div></div>
      <div class="fact" title="${adpTooltip(p.id)}"><div class="v">${p.adp}</div><div class="l">ADP</div></div>
      <div class="fact"><div class="v">${tiers[p.id]}</div><div class="l">Tier</div></div>
      <div class="fact"><div class="v">${p.b||'—'}</div><div class="l">Bye</div></div>
    </div>
    ${injuryHtml}
    ${statsHtml}
    <div class="sheetbtns" id="pdBtns"></div>`;
  $('pdClose').onclick=()=>$('pModal').classList.remove('open');
  const btns=$('pdBtns');
  if(!st){
    const bs=starButton(id); bs.style.cssText='width:46px;height:auto;font-size:18px;';
    bs.onclick=()=>{ toggleStar(id); $('pModal').classList.remove('open'); };
    const bc=document.createElement('button'); bc.className='btn ghost'; bc.style.cssText='width:46px;font-size:16px;padding:9px 0;';
    bc.textContent='⚖';
    bc.onclick=()=>{ toggleCompare(id); $('pModal').classList.remove('open');
      const p=PLAYERS.find(x=>x.id===id);
      if(S.ui.cmp.includes(id)) toast(`${p.n} added to compare (${S.ui.cmp.length})`); };
    const b1=document.createElement('button'); b1.className='btn taken'; b1.style.flex='1'; b1.textContent='Taken';
    b1.onclick=()=>{ $('pModal').classList.remove('open'); mark(id,'taken'); };
    const b2=document.createElement('button'); b2.className='btn mine'; b2.style.flex='1'; b2.textContent='Draft to my team';
    b2.onclick=()=>{ $('pModal').classList.remove('open'); mark(id,'mine'); };
    btns.appendChild(bs); btns.appendChild(bc); btns.appendChild(b1); btns.appendChild(b2);
  } else {
    const a=S.actions.find(x=>x.id===id);
    btns.innerHTML=`<div class="note" style="flex:1;text-align:center">${st==='mine'?'On your roster':'Drafted by '+teamLabel(teamOnClock(a.pick))} — pick #${a.pick}</div>
      <button class="btn ghost" id="pdRemove" style="width:100%">✕ Remove from board</button>`;
    $('pdRemove').onclick=()=>{
      if(!confirm(`Remove ${p.n} from pick #${a.pick}? The cell opens up so you can reassign it.`)) return;
      S.actions=S.actions.filter(x=>x.id!==id);
      rebuildStatus();
      $('pModal').classList.remove('open');
      toast(`${p.n} removed — pick #${a.pick} is open`);
      renderAll();
    };
  }
  $('pModal').classList.add('open');
}
$('pModal').onclick=e=>{ if(e.target===$('pModal')) $('pModal').classList.remove('open'); };
/* ---------- compare ---------- */
function toggleCompare(id){
  const c=S.ui.cmp, i=c.indexOf(id);
  if(i>=0) c.splice(i,1);
  else{
    if(c.length>=4){ toast('Compare up to 4 players'); return; }
    c.push(id);
  }
  renderCmpBar();
  if(S.ui.tab==='draft') renderBoard();
}
function renderCmpBar(){
  const c=S.ui.cmp;
  const wasShown=$('cmpBar').classList.contains('show');
  $('cmpBar').classList.toggle('show', c.length>0);
  if(c.length>0 && !wasShown) $('cmpBar').querySelector('.cmpbar-in').classList.add('dd-rise');
  $('cmpNames').innerHTML = c.map(id=>PLAYERS.find(p=>p.id===id).n.split(' ').slice(-1)[0]).join(' <span style="color:var(--dim)">vs</span> ');
  $('cmpOpen').disabled = c.length<2;
  $('cmpOpen').style.opacity = c.length<2?'.5':'1';
}
function compact2025(id){
  const s=STATS[String(id)];
  if(!s) return null;
  return s.rows.map(r=>`${r[1]} ${r[0].toLowerCase()}`).join(' · ');
}
function openCompare(){
  const ids=S.ui.cmp; if(ids.length<2) return;
  const ps=ids.map(id=>PLAYERS.find(p=>p.id===id));
  const scores=scoreAvailable();
  const info=ps.map(p=>{
    const sc=scores.find(x=>x.p.id===p.id);
    const st=status[p.id];
    const s=STATS[String(p.id)];
    return {p, st, s, score:sc?sc.score:null, reasons:sc?sc.reasons:[],
      ppg: s? s.fp/s.g : null};
  });
  const n=ids.length;
  const grid=(cells)=>`<div class="cmp-grid" style="grid-template-columns:78px repeat(${n},1fr)">${cells}</div>`;
  const bestIdx=(vals,dir)=>{ // dir 1: higher best, -1: lower best
    let bi=-1,bv=null;
    vals.forEach((v,i)=>{ if(v==null)return;
      if(bv==null || (dir>0? v>bv : v<bv)){ bv=v; bi=i; } });
    return vals.filter(v=>v!=null).length>1 ? bi : -1;
  };
  const rowH=(lab,vals,dir,subs)=>{
    const bi = dir? bestIdx(vals.map(v=>typeof v==='number'?v:null),dir) : -1;
    return `<div class="cmp-cell lab">${lab}</div>`+vals.map((v,i)=>
      `<div class="cmp-cell${i===bi?' best':''}">${v==null?'—':(typeof v==='number'? (Number.isInteger(v)?v:v.toFixed(1)) : v)}${subs&&subs[i]?`<span class="sub">${subs[i]}</span>`:''}</div>`).join('');
  };
  const {picks}=myRoster();
  const myByes={}; for(const p of picks) if(p.b) myByes[p.b]=(myByes[p.b]||0)+1;
  let html='';
  html+=grid(
    `<div class="cmp-cell lab"></div>`+info.map(x=>
      `<div class="cmp-cell head" style="display:flex; flex-direction:column; align-items:center; gap:4px">${avatarHtml(x.p,'sm')}<div>${x.p.n}</div><span class="sub"><span class="posbadge ${posColor(x.p.p)}">${x.p.p}${x.p.pr}</span>${x.p.t}${x.st?(x.st==='mine'?' · MINE':' · GONE'):''}</span></div>`).join('')
    +rowH(`<span title="${ADP_TOOLTIP}">Consensus</span>`, info.map(x=>x.p.id), -1)
    +rowH(`<span title="${info.every(x=>ENRICH[x.p.id]&&typeof ENRICH[x.p.id].live_adp==='number')?LIVE_ADP_TOOLTIP:ADP_TOOLTIP}">ADP</span>`, info.map(x=>x.p.adp), -1)
    +rowH('Tier', info.map(x=>tiers[x.p.id]), -1)
    +rowH('Bye', info.map(x=>x.p.b||null), 0, info.map(x=>x.p.b&&myByes[x.p.b]?`⚠ ${myByes[x.p.b]} of yours`:''))
    +rowH('Injury', info.map(x=>{ const e=ENRICH[x.p.id]; return e?(e.injury_status||'Active'):null; }), 0)
    +rowH('2025 pts', info.map(x=>x.s?x.s.fp:null), 1)
    +rowH('Pts/game', info.map(x=>x.ppg), 1)
    +rowH('Games', info.map(x=>x.s?x.s.g:null), 0)
    +rowH('Draft fit', info.map(x=>x.score!=null?Math.round(x.score):null), 1, info.map(x=>x.st?'drafted':''))
  );
  // 2025 stat lines
  html+='<div style="margin-top:10px">'+info.map(x=>{
    const line=compact2025(x.p.id);
    return `<div class="note" style="margin-top:6px"><b style="color:var(--text)">${x.p.n.split(' ').slice(-1)[0]} '25:</b> ${line||'no NFL stats (rookie or missed season)'}</div>`;
  }).join('')+'</div>';
  // verdict
  const avail=info.filter(x=>!x.st && x.score!=null);
  if(avail.length>=2){
    const sorted=[...avail].sort((a,b)=>b.score-a.score);
    const [a,b]=sorted;
    const margin=a.score-b.score;
    const close=margin<12;
    const why=a.reasons.slice(0,2).map(r=>r.t).join('; ')||'stronger overall value';
    html+=`<div class="verdict${close?' tie':''}">`+(close
      ? `⚖ <b>Coin flip</b> — slight edge to <b>${a.p.n}</b> (${why}). Worth asking Claude below.`
      : `✅ The app leans <b>${a.p.n}</b> — ${why}.`)
      +(info.some(x=>x.st)?` <span style="color:var(--dim)">(drafted players excluded from verdict)</span>`:'')
      +`</div>`;
  } else if(avail.length===1){
    html+=`<div class="verdict">✅ <b>${avail[0].p.n}</b> is the only one still available.</div>`;
  } else {
    html+=`<div class="verdict tie">All of these players are already drafted.</div>`;
  }
  $('cBody').innerHTML=html;
  $('cModal').classList.add('open');
}
function buildCompareText(){
  const ids=S.ui.cmp;
  const {picks}=myRoster(); const need=openStarters();
  const nxt=nextMyPicks(3);
  const scores=scoreAvailable();
  const lines=[];
  lines.push('PLAYER COMPARISON — help me pick one');
  lines.push(`League: ${S.teams}-team PPR snake, slot ${S.slot}. Current overall pick ${S.pick}; my upcoming picks: ${nxt.map(x=>'#'+x).join(', ')||'none'}.`);
  lines.push(`My roster: ${picks.length?picks.map(p=>`${p.n} (${p.p}${p.pr}, bye ${p.b||'—'})`).join(', '):'(empty)'}`);
  lines.push(`Open starting slots: ${Object.keys(need).length?Object.entries(need).map(([k,v])=>`${k}×${v}`).join(', '):'none'}`);
  lines.push('');
  lines.push('CANDIDATES:');
  ids.forEach((id,i)=>{
    const p=PLAYERS.find(x=>x.id===id);
    const st=status[id]; const s=STATS[String(id)];
    const sc=scores.find(x=>x.p.id===id);
    lines.push(`${i+1}. ${p.n} — ${p.p}${p.pr}, ${p.t}, bye ${p.b||'—'} · consensus #${p.id}, ADP ${p.adp}, Tier ${tiers[p.id]}${st?` · ALREADY DRAFTED (${st})`:''}`);
    lines.push(`   2025: ${s?`${s.g} games, ${s.fp.toFixed(1)} PPR pts (${(s.fp/s.g).toFixed(1)}/g) — ${compact2025(id)}`:'no NFL stats (rookie or missed season)'}`);
    if(sc && sc.reasons.length) lines.push(`   App notes: ${sc.reasons.slice(0,3).map(r=>r.t).join('; ')}`);
  });
  lines.push('');
  lines.push('QUESTION: Which of these should I draft and why? Consider my roster construction, tier/positional scarcity, injury risk from 2025 games missed, bye overlap with my roster, and whether the others might still be available at my next pick.');
  return lines.join('\n');
}
function renderTeam(){
  const {slots,picks}=myRoster();
  const el=$('roster'); el.innerHTML='';
  for(const s of slots){
    const d=document.createElement('div'); d.className='slotrow';
    d.innerHTML=`<div class="slotlab">${s.lab}</div>`+
      (s.pl ? `${avatarHtml(s.pl,'sm')}<div><b>${s.pl.n}</b>${injuryBadgeHtml(s.pl.id)} <span style="color:var(--dim);font-size:12px">· ${teamLogoHtml(s.pl.t)}${s.pl.t} · Bye ${s.pl.b||'—'} · pick #${s.pl.pickNo}</span></div>`
            : `<div class="empty">— open —</div>`);
    el.appendChild(d);
  }
  const byes={}; for(const p of picks) if(p.b) byes[p.b]=(byes[p.b]||0)+1;
  const bad=Object.entries(byes).filter(([w,c])=>c>=3);
  $('byeWarn').textContent = bad.length? '⚠ Bye week pile-up: '+bad.map(([w,c])=>`week ${w} (${c} players)`).join(', ') : '';
  const need=openStarters();
  $('needs').textContent = Object.keys(need).length
    ? 'Still need starters: '+Object.entries(need).map(([k,v])=>`${k}×${v}`).join(', ')
    : 'All starting slots filled — building bench depth now.';
}
function rebuildLogTeamFilter(){
  const sel=$('logTeamFilter');
  const cur=sel.value || S.ui.logTeam;
  sel.innerHTML=`<option value="ALL">All teams</option><option value="MINE">My picks</option>`
    + Array.from({length:S.teams},(_, i)=>`<option value="${i+1}">${teamLabel(i+1)}</option>`).join('');
  sel.value = [...sel.options].some(o=>o.value===cur) ? cur : 'ALL';
  S.ui.logTeam = sel.value;
}
function renderLog(){
  const el=$('log');
  rebuildLogTeamFilter();
  let list=[...S.actions];
  if(S.ui.logSort==='desc') list.reverse();
  const q=(S.ui.logQ||'').toLowerCase();
  list=list.filter(a=>{
    const p=PLAYERS.find(x=>x.id===a.id);
    if(S.ui.logPos!=='ALL' && p.p!==S.ui.logPos) return false;
    if(S.ui.logTeam==='MINE'){ if(a.kind!=='mine') return false; }
    else if(S.ui.logTeam!=='ALL' && teamOnClock(a.pick)!==Number(S.ui.logTeam)) return false;
    if(q && !(p.n.toLowerCase().includes(q) || p.t.toLowerCase().includes(q) || p.p.toLowerCase().includes(q))) return false;
    return true;
  });
  el.innerHTML='';
  if(!S.actions.length){
    el.innerHTML=`<div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No picks yet</div>
        <div class="empty-sub">Every pick will show up here as the draft goes.</div>
      </div>`;
    return;
  }
  if(!list.length){
    el.innerHTML=`<div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No picks match these filters</div>
        <div class="empty-sub">Try clearing the search, position, or team filter.</div>
      </div>`;
    return;
  }
  list.forEach(a=>{
    const p=PLAYERS.find(x=>x.id===a.id);
    const d=document.createElement('div'); d.className='logrow'+(a.kind==='mine'?' mine':'');
    d.innerHTML=`<div class="logpick">#${a.pick} R${roundOf(a.pick)}</div>
      ${avatarHtml(p,'sm')}
      <span class="posbadge ${posColor(p.p)}">${p.p}</span>
      <div style="flex:1; min-width:0">${p.n}${injuryBadgeHtml(p.id)} <span style="color:var(--dim);font-size:12px">${teamLogoHtml(p.t)}${p.t}</span></div>
      <div style="font-size:11px;font-weight:800;color:${a.kind==='mine'?'var(--me)':'var(--dim)'}">${a.kind==='mine'?'YOU':teamLabel(teamOnClock(a.pick))}</div>`;
    d.onclick=()=>openPlayer(a.id);
    el.appendChild(d);
  });
}
function renderDraftBoard(){
  const el=$('dbGrid');
  el.style.gridTemplateColumns=`34px repeat(${S.teams},1fr)`;
  let html='<div class="dbcell dbcorner"></div>';
  for(let t=1;t<=S.teams;t++){
    const mine=t===S.slot;
    html+=`<div class="dbcell dbhead${mine?' dbmine':''}">${mine?'YOU':teamLabel(t,true)}</div>`;
  }
  for(let r=1;r<=S.rounds;r++){
    html+=`<div class="dbcell dbrnd">${r}</div>`;
    for(let t=1;t<=S.teams;t++){
      const mine=t===S.slot;
      const pickNo=pickForRoundTeam(r,t);
      const a=S.actions.find(x=>x.pick===pickNo);
      if(a){
        const p=PLAYERS.find(x=>x.id===a.id);
        html+=`<div class="dbcell dbpick${mine?' dbmine':''}" data-id="${p.id}" title="${p.n} — pick #${a.pick}">
            <span class="posbadge ${posColor(p.p)}">${p.p}</span>
            <div class="dbname">${p.n.split(' ').slice(-1)[0]}</div>
          </div>`;
      } else {
        const isClock = pickNo===S.pick && S.pick<=totalPicks();
        const isEditable = pickNo<S.pick;
        html+=`<div class="dbcell dbempty${mine?' dbmine':''}${isClock?' dbclock':''}${isEditable?' dbeditable':''}"${isEditable?` data-pick="${pickNo}" title="Assign pick #${pickNo}"`:''}>${isClock?'●':(isEditable?'+':'·')}</div>`;
      }
    }
  }
  el.innerHTML=html;
  el.querySelectorAll('.dbpick').forEach(c=>{ c.onclick=()=>openPlayer(Number(c.dataset.id)); });
  el.querySelectorAll('.dbeditable').forEach(c=>{ c.onclick=()=>openAssignPick(Number(c.dataset.pick)); });
}
function assignToPick(id, pickNo, kind){
  if(status[id]) return;
  S.actions.push({id, kind, pick:pickNo});
  rebuildStatus();
  const p=PLAYERS.find(x=>x.id===id);
  toast(`${p.n} assigned to pick #${pickNo}`);
  renderAll();
}
function openAssignPick(pickNo){
  const r=roundOf(pickNo), team=teamOnClock(pickNo), mine=team===S.slot, kind=mine?'mine':'taken';
  const sheet=$('pSheet');
  const rowsHtml=(q)=>{
    const ql=(q||'').toLowerCase();
    const avail=PLAYERS.filter(p=>!status[p.id] && (!ql || p.n.toLowerCase().includes(ql) || p.t.toLowerCase().includes(ql))).slice(0,40);
    if(!avail.length) return `<div class="note" style="text-align:center">No matching available players.</div>`;
    return avail.map(p=>`<div class="asgrow" data-id="${p.id}">
        ${avatarHtml(p,'sm')}
        <span class="posbadge ${posColor(p.p)}">${p.p}${p.pr}</span>
        <span class="asgname">${p.n}</span>
        <span class="asgmeta">${p.t} · ADP ${p.adp}</span>
      </div>`).join('');
  };
  const wireRows=()=>{
    $('asgList').querySelectorAll('.asgrow').forEach(row=>{
      row.onclick=()=>{ assignToPick(Number(row.dataset.id), pickNo, kind); $('pModal').classList.remove('open'); };
    });
  };
  sheet.innerHTML=`<div class="pd-head">
      <div style="flex:1">
        <h3 style="margin:0">Assign pick #${pickNo}</h3>
        <div class="pd-sub">Round ${r} · ${mine?'YOU':teamLabel(team)}</div>
      </div>
      <button class="iconbtn" id="pdClose">✕</button>
    </div>
    <input type="search" id="asgSearch" placeholder="Search player or team…" style="width:100%; margin-top:10px">
    <div id="asgList" class="asglist"></div>`;
  $('pdClose').onclick=()=>$('pModal').classList.remove('open');
  $('asgList').innerHTML=rowsHtml('');
  wireRows();
  $('asgSearch').oninput=e=>{ $('asgList').innerHTML=rowsHtml(e.target.value); wireRows(); };
  $('pModal').classList.add('open');
}
/* ---------- two-pane resizable shell ---------- */
function applyPaneLayout(){
  const wrap=$('wrap');
  applySideOrder();
  document.querySelectorAll('.panebtns button').forEach(b=>{
    b.classList.toggle('active', b.dataset.pane===(S.pane||'split'));
  });
  if(S.pane==='main'){
    wrap.style.gridTemplateColumns='1fr';
    $('splitter').style.display='none';
    $('sidebar').style.display='none';
    $('mainPane').style.display='block';
    $('mainPaneBtns').style.display='flex';
  } else if(S.pane==='side'){
    wrap.style.gridTemplateColumns='1fr';
    $('splitter').style.display='none';
    $('mainPane').style.display='none';
    $('sidebar').style.display='flex';
    $('mainPaneBtns').style.display='none';
  } else {
    wrap.style.gridTemplateColumns=`minmax(0, ${S.split}fr) 10px minmax(0, ${1-S.split}fr)`;
    $('splitter').style.display='block';
    $('mainPane').style.display='block';
    $('sidebar').style.display='flex';
    $('mainPaneBtns').style.display='none';
  }
}
function setPane(mode){ S.pane = mode==='split' ? null : mode; applyPaneLayout(); scheduleCloudSave(); }
document.querySelectorAll('.panebtns').forEach(el=>{
  el.onclick=e=>{ const b=e.target.closest('button'); if(!b) return; setPane(b.dataset.pane); };
});
(function(){
  const splitter=$('splitter');
  let dragging=false;
  splitter.addEventListener('pointerdown', e=>{ dragging=true; splitter.setPointerCapture(e.pointerId); });
  document.addEventListener('pointermove', e=>{
    if(!dragging || S.pane) return;
    const rect=$('wrap').getBoundingClientRect();
    let frac=(e.clientX-rect.left)/rect.width;
    frac=Math.max(.22, Math.min(.82, frac));
    S.split=frac;
    $('wrap').style.gridTemplateColumns=`minmax(0, ${S.split}fr) 10px minmax(0, ${1-S.split}fr)`;
  });
  document.addEventListener('pointerup', ()=>{ if(dragging){ dragging=false; scheduleCloudSave(); } });
  splitter.addEventListener('dblclick', ()=>{ S.split=.5; applyPaneLayout(); scheduleCloudSave(); });
})();
/* ---------- sidebar: roster needs + tier watch, draft flow ---------- */
function renderNeedsCard(){
  const el=$('needsCard'); if(!el) return;
  const {slots}=myRoster();
  const pillsHtml=['QB','RB','WR','TE','K','DST'].map(pos=>{
    const total=slots.filter(s=>s.pos===pos).length;
    if(!total) return '';
    const filled=slots.filter(s=>s.pos===pos && s.pl).length;
    const short=total-filled;
    const cls = short<=0 ? 'ok' : (short===1 ? 'warn' : 'bad');
    return `<span class="needpill ${cls}">${pos} ${filled}/${total}</span>`;
  }).join('');
  const tierRows=['RB','WR','TE','QB'].map(pos=>{
    const avail=PLAYERS.filter(p=>p.p===pos && !status[p.id]).sort((a,b)=>tiers[a.id]-tiers[b.id] || a.adp-b.adp);
    if(!avail.length) return '';
    const top=avail[0], tierNum=tiers[top.id];
    const count=avail.filter(p=>tiers[p.id]===tierNum).length;
    const scarcity = count<=2?'bad':(count<=4?'warn':'ok');
    return `<div class="tierrow"><span class="posbadge ${posColor(pos)}">${pos}</span><span class="tiertxt">Tier ${tierNum} — ${top.n}</span><span class="tiercount ${scarcity}">${count}</span></div>`;
  }).join('');
  el.innerHTML=`<h3>Roster needs</h3><div class="needpills">${pillsHtml}</div>
    <h3 class="tight">Tier watch</h3><div class="tierrows">${tierRows}</div>`;
}
function renderFlowCard(){
  const el=$('flowCard'); if(!el) return;
  const nxt=nextMyPicks(3).map(x=>'#'+x).join(', ')||'none left';
  el.innerHTML=`<h3>Draft flow</h3><div class="flowtxt">${S.actions.length} of ${totalPicks()} picks logged. You hold slot ${S.slot}, so your picks run ${nxt}, and on down the snake.</div>`;
}
/* ---------- sidebar: positional trend ---------- */
const TREND_POS_ORDER=['QB','RB','WR','TE','K','DST'];
function computeTrend(){
  const roundNums=[...new Set(S.actions.map(a=>roundOf(a.pick)))].sort((a,b)=>a-b);
  const rounds=roundNums.map(r=>{
    const picksInRound=S.actions.filter(a=>roundOf(a.pick)===r);
    const counts={};
    for(const a of picksInRound){ const p=PLAYERS.find(x=>x.id===a.id); counts[p.p]=(counts[p.p]||0)+1; }
    const total=picksInRound.length;
    const segments=TREND_POS_ORDER.filter(pos=>counts[pos]).map(pos=>({pos, count:counts[pos]}));
    const top=[...segments].sort((a,b)=>b.count-a.count)[0];
    return {r, total, segments, pos:top.pos, count:top.count};
  });
  let run=0, runPos=null;
  if(S.actions.length){
    runPos=PLAYERS.find(x=>x.id===S.actions[S.actions.length-1].id).p;
    for(let i=S.actions.length-1;i>=0;i--){
      const p=PLAYERS.find(x=>x.id===S.actions[i].id).p;
      if(p===runPos) run++; else break;
    }
  }
  return {rounds, run, runPos, hasRun: run>=3};
}
function renderTrendCard(){
  const el=$('trendCard'); if(!el) return;
  const wrapper=el.closest('.sidecard');
  if(!S.actions.length){
    el.innerHTML=`<h3>Trend</h3><div class="note" style="margin:0">Position mix appears once picks are logged.</div>`;
    if(wrapper) wrapper.classList.remove('runactive');
    return;
  }
  const {rounds, run, runPos, hasRun}=computeTrend();
  const usedPositions=new Set(rounds.flatMap(r=>r.segments.map(s=>s.pos)));
  const barsHtml=rounds.map(r=>{
    const segsHtml=r.segments.map(seg=>{
      const share=seg.count/r.total;
      const showLabel=share>=0.22;
      return `<div class="trendseg" style="flex:${seg.count} 0 0; background:var(--${seg.pos.toLowerCase()})" title="${seg.pos} ${seg.count}/${r.total}">${showLabel?`<span class="trendseg-lab">${seg.pos} ${seg.count}</span>`:''}</div>`;
    }).join('');
    return `<div class="trendbar-col">
        <div class="trendbar">${segsHtml}</div>
        <div class="trendbar-rd">Rd ${r.r}</div>
      </div>`;
  }).join('');
  const legendHtml=TREND_POS_ORDER.filter(pos=>usedPositions.has(pos)).map(pos=>
    `<span class="trendlegend-item"><span class="trendlegend-dot" style="background:var(--${pos.toLowerCase()})"></span>${pos}</span>`).join('');
  const recentTxt=`Last ${Math.min(10,S.actions.length)} picks: `+S.actions.slice(-10).map(a=>PLAYERS.find(p=>p.id===a.id).p).join(', ');
  const badge=hasRun?`<span class="trendbadge dd-pulse">${runPos} run · ${run} straight</span>`:'';
  el.innerHTML=`<h3>Trend${badge}</h3>
    <div class="note" style="margin:0 0 8px">Full position mix drafted each round.</div>
    <div class="trendlegend">${legendHtml}</div>
    <div class="trendchart">${barsHtml}</div>
    <div class="note" style="margin-top:6px">${recentTxt}</div>`;
  if(wrapper){
    wrapper.classList.toggle('runactive', hasRun);
    if(hasRun) wrapper.style.setProperty('--runcolor', `var(--${runPos.toLowerCase()})`);
  }
}
/* ---------- sidebar: notes ---------- */
function addNote(){
  const input=$('noteInput'); if(!input) return;
  const text=input.value.trim(); if(!text) return;
  const stamp = S.started ? `R${roundOf(S.pick)}·#${S.pick}` : '—';
  S.notes=S.notes||[];
  S.notes.push({id:(crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random())), text, pinned:false, stamp});
  input.value='';
  renderNotesCard(); scheduleCloudSave();
}
function toggleNotePin(id){
  const n=(S.notes||[]).find(x=>x.id===id); if(!n) return;
  n.pinned=!n.pinned; renderNotesCard(); scheduleCloudSave();
}
function deleteNote(id){
  S.notes=(S.notes||[]).filter(x=>x.id!==id);
  renderNotesCard(); scheduleCloudSave();
}
function startEditNote(id){
  const row=document.querySelector(`.noterow[data-id="${id}"]`);
  const n=(S.notes||[]).find(x=>x.id===id);
  if(!row||!n) return;
  const textDiv=row.querySelector('.notetext'); if(!textDiv) return;
  textDiv.outerHTML=`<input type="text" class="noteeditinput" draggable="false">`;
  const input=row.querySelector('.noteeditinput');
  input.value=n.text; input.focus(); input.select();
  let done=false;
  const save=()=>{ if(done) return; done=true; n.text=input.value.trim()||n.text; renderNotesCard(); scheduleCloudSave(); };
  input.onkeydown=e=>{
    if(e.key==='Enter'){ e.preventDefault(); save(); }
    else if(e.key==='Escape'){ e.preventDefault(); done=true; renderNotesCard(); }
  };
  input.onblur=save;
}
function renderNotesCard(){
  const el=$('notesCard'); if(!el) return;
  const notes=[...(S.notes||[])].sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));
  const countHtml = notes.length ? `<span class="qcount">${notes.length}</span>` : '';
  const rowsHtml = notes.length ? notes.map(n=>`
    <div class="noterow${n.pinned?' pinned':''}" data-id="${n.id}">
      <button class="notepin" data-act="pin" title="Pin">${n.pinned?'★':'☆'}</button>
      <div class="notetext" data-act="edit">${escapeHtml(n.text)}</div>
      <span class="notestamp">${n.stamp}</span>
      <button class="noteedit" data-act="edit" title="Edit">✎</button>
      <button class="notedel" data-act="del" title="Delete">×</button>
    </div>`).join('') : `<div class="note" style="margin:0">No notes yet.</div>`;
  el.innerHTML=`<h3>Notes ${countHtml}</h3>
    <div class="noteadd"><input type="text" id="noteInput" draggable="false" placeholder="Add a note…"><button class="btn ghost" id="noteAddBtn">Add</button></div>
    <div class="noterows">${rowsHtml}</div>`;
  $('noteInput').onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); addNote(); } };
  $('noteAddBtn').onclick=addNote;
  el.querySelectorAll('.noterow').forEach(row=>{
    const id=row.dataset.id;
    row.querySelector('[data-act="pin"]').onclick=()=>toggleNotePin(id);
    row.querySelector('.notedel').onclick=()=>deleteNote(id);
    row.querySelectorAll('[data-act="edit"]').forEach(x=>x.onclick=()=>startEditNote(id));
  });
}
/* ---------- sidebar: drag-to-reorder ---------- */
function applySideOrder(){
  const order = (S.sideOrder && S.sideOrder.length) ? S.sideOrder : ['needs','flow','reset','trend','notes'];
  order.forEach((key,i)=>{
    const el=document.querySelector(`.sidecard[data-key="${key}"]`);
    if(el) el.style.order=i;
  });
}
(function wireSidebarDrag(){
  document.querySelectorAll('.sidecard').forEach(el=>{
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', el.dataset.key);
      e.dataTransfer.effectAllowed='move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', ()=>el.classList.remove('dragging'));
    el.addEventListener('dragover', e=>e.preventDefault());
    el.addEventListener('drop', e=>{
      e.preventDefault();
      const draggedKey=e.dataTransfer.getData('text/plain');
      const targetKey=el.dataset.key;
      if(!draggedKey || draggedKey===targetKey) return;
      const order=S.sideOrder||['needs','flow','reset','trend','notes'];
      const from=order.indexOf(draggedKey), to=order.indexOf(targetKey);
      if(from<0||to<0) return;
      order.splice(from,1); order.splice(to,0,draggedKey);
      S.sideOrder=order;
      applySideOrder(); scheduleCloudSave();
    });
  });
})();
function renderAll(){
  renderStatus();
  const t=S.ui.tab;
  $('draftView').style.display = t==='draft'?'block':'none';
  $('boardView').style.display = t==='board'?'block':'none';
  $('queueView').style.display = t==='queue'?'block':'none';
  $('teamView').style.display = t==='team'?'block':'none';
  $('logView').style.display = t==='log'?'block':'none';
  $('buddyView').style.display = t==='buddy'?'block':'none';
  $('bottombar').style.display = (S.started && t!=='buddy') ? 'block':'none';
  $('chatbar').style.display = (S.started && t==='buddy') ? 'block':'none';
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));
  const avail=S.queue.filter(id=>!status[id]).length;
  $('qCount').style.display = avail? 'inline-block':'none';
  $('qCount').textContent = avail;
  if(t==='draft'){ renderRecs(); renderBuddyLatest(); renderBoard(); }
  if(t==='board') renderDraftBoard();
  if(t==='queue') renderQueue();
  if(t==='team') renderTeam();
  if(t==='log') renderLog();
  if(t==='buddy') renderChat();
  if(S.started){ applyPaneLayout(); renderNeedsCard(); renderFlowCard(); renderTrendCard(); renderNotesCard(); }
  scheduleCloudSave();
}
/* ---------- actions ---------- */
function mark(id, kind){
  if(status[id]) return;
  if(S.pick>totalPicks()){ toast('Draft is complete'); return; }
  if(kind==='taken' && teamOnClock(S.pick)===S.slot){
    const p=PLAYERS.find(x=>x.id===id);
    if(!confirm(`It's your turn — mark ${p.n} as taken by someone else instead of drafting them yourself?`)) return;
  }
  if(kind==='mine' && teamOnClock(S.pick)!==S.slot){
    const p=PLAYERS.find(x=>x.id===id);
    if(!confirm(`It's not your turn (${teamLabel(teamOnClock(S.pick))} is on the clock) — add ${p.n} to your team anyway?`)) return;
  }
  S.actions.push({id, kind, pick:S.pick});
  S.pick++;
  rebuildStatus();
  const p=PLAYERS.find(x=>x.id===id);
  toast(kind==='mine' ? `You drafted ${p.n}!` : `${p.n} — gone`);
  renderAll();
}
$('undoBtn').onclick=()=>{
  const a=S.actions.pop();
  if(!a){ toast('Nothing to undo'); return; }
  S.pick=a.pick; rebuildStatus(); toast('Undone'); renderAll();
};
function simPick(){
  if(S.pick>totalPicks()) return false;
  const avail=PLAYERS.filter(p=>!status[p.id]).sort((a,b)=>a.adp-b.adp);
  if(!avail.length) return false;
  const pick=avail[Math.floor(Math.random()*Math.min(3,avail.length))];
  mark(pick.id,'taken');
  return true;
}
$('simBtn').onclick=()=>{ if(!simPick()) toast('Nothing left to sim'); };
$('simToMineBtn').onclick=()=>{
  const remaining=nextMyPicks(1);
  if(!remaining.length){ toast('No picks left for your slot'); return; }
  const n=remaining[0]-S.pick;
  if(n<=0){ toast("You're already on the clock"); return; }
  if(!confirm(`Simulate ${n} pick${n===1?'':'s'} up to your turn?`)) return;
  while(teamOnClock(S.pick)!==S.slot && S.pick<=totalPicks()){ if(!simPick()) break; }
};
/* ---------- copy state for Claude ---------- */
function buildClaudeText(){
  const {picks}=myRoster();
  const need=openStarters();
  const nxt=nextMyPicks(4);
  const avail=recommend(30);
  const recent=S.actions.slice(-12).map(a=>{
    const p=PLAYERS.find(x=>x.id===a.id);
    return `#${a.pick} ${p.n} (${p.p}${p.pr})${a.kind==='mine'?' *ME*':''}`; });
  const lines=[];
  lines.push(`FANTASY DRAFT — LIVE STATE`);
  lines.push(`League: ${S.teams}-team PPR snake, ${S.rounds} rounds. I draft from slot ${S.slot}.`);
  lines.push(`Lineup: ${['QB','RB','WR','TE','FLEX','K','DST','BN'].map(k=>`${k}:${S.req[k]}`).join(' ')}`);
  lines.push(`Current overall pick: ${S.pick} (Round ${Math.min(roundOf(Math.min(S.pick,totalPicks())),S.rounds)}). ${teamOnClock(Math.min(S.pick,totalPicks()))===S.slot&&S.pick<=totalPicks()?'IT IS MY PICK NOW.':''}`);
  lines.push(`My upcoming picks: ${nxt.length?nxt.map(x=>'#'+x).join(', '):'none left'}`);
  lines.push(``);
  lines.push(`MY ROSTER SO FAR:`);
  lines.push(picks.length? picks.map(p=>`- ${p.n} (${p.p}${p.pr}, ${p.t}, bye ${p.b||'—'}) — pick #${p.pickNo}`).join('\n') : '- (empty)');
  lines.push(`Open starting slots: ${Object.keys(need).length?Object.entries(need).map(([k,v])=>`${k}×${v}`).join(', '):'none — bench from here'}`);
  const q=S.queue.filter(id=>!status[id]).map(id=>{const p=PLAYERS.find(x=>x.id===id);return `${p.n} (${p.p}${p.pr})`;});
  lines.push(`MY QUEUE (my own priority order): ${q.length?q.join(', '):'(empty)'}`);
  lines.push(``);
  lines.push(`TOP 30 AVAILABLE (my app's rank order · consensus rank, pos, team, bye, ADP, tier):`);
  avail.forEach((r,i)=>lines.push(`${i+1}. ${r.p.n} — #${r.p.id} ${r.p.p}${r.p.pr} ${r.p.t} bye ${r.p.b||'—'} ADP ${r.p.adp} T${tiers[r.p.id]}`));
  lines.push(``);
  lines.push(`LAST 12 PICKS: ${recent.join(' · ')||'none'}`);
  lines.push(``);
  lines.push(`QUESTION: Who should I target with my next pick and why? Consider tiers, positional scarcity, my roster needs, bye overlap, and who is likely to still be there at my following pick.`);
  return lines.join('\n');
}
/* ---------- draft buddy chat ---------- */
let chatHistory=[]; // [{role:'user'|'assistant', content:'...'}]
let chatBusy=false;
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const QUICK_PROMPTS=['Who should I take?', 'Am I too heavy at one position?', 'Best value on the board?'];
function renderQuickPrompts(){
  const el=$('quickPrompts'); if(!el) return;
  if(chatHistory.length){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='flex';
  el.innerHTML=QUICK_PROMPTS.map(q=>`<button class="qp">${q}</button>`).join('');
  el.querySelectorAll('.qp').forEach((b,i)=>{
    b.onclick=()=>{ $('chatInput').value=QUICK_PROMPTS[i]; sendChat(); };
  });
}
function renderChat(){
  renderQuickPrompts();
  const el=$('chatMessages');
  if(!chatHistory.length){
    el.innerHTML=`<div class="empty-state">
        <div class="empty-icon">🏈</div>
        <div class="empty-title">Ask Buddy anything</div>
        <div class="empty-sub">"Who should I target next?" · "RB or WR here?" · "Am I too heavy at one position?"</div>
      </div>`;
    return;
  }
  el.innerHTML=chatHistory.map(m=>{
    const pending=m.role==='assistant' && !m.content && !m.errored;
    const cls=m.role+(m.errored?' error':'');
    const body=pending ? '<span class="chat-typing">●●●</span>' : escapeHtml(m.content).replace(/\n/g,'<br>');
    return `<div class="chat-msg ${cls}">${body}</div>`;
  }).join('');
  el.scrollTop=el.scrollHeight;
}
async function sendChat(){
  const input=$('chatInput');
  const text=input.value.trim();
  if(!text||chatBusy) return;
  input.value='';
  chatHistory.push({role:'user', content:text});
  const replyIdx=chatHistory.push({role:'assistant', content:''})-1;
  renderChat();
  chatBusy=true; $('chatSend').disabled=true;
  try{
    const draftState = S.started ? buildClaudeText() : 'The draft has not started yet — only the consensus player pool is available.';
    const res=await fetch('/api/chat', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        messages: chatHistory.slice(0,-1).map(m=>({role:m.role, content:m.content})),
        draftState,
        hotTakes: S.ui.hotTakes,
      }),
    });
    if(!res.ok || !res.body){
      let msg='Buddy is unavailable right now.';
      try{ const errBody=await res.json(); if(errBody && errBody.message) msg=errBody.message; }catch(e){}
      throw new Error(msg);
    }
    const reader=res.body.getReader();
    const decoder=new TextDecoder();
    let acc='';
    while(true){
      const {done, value}=await reader.read();
      if(done) break;
      acc+=decoder.decode(value, {stream:true});
      chatHistory[replyIdx].content=acc;
      renderChat();
    }
    if(!acc) chatHistory[replyIdx].content='(Buddy had nothing to say — try rephrasing.)';
  }catch(e){
    chatHistory[replyIdx].content=`⚠ ${e.message||'Something went wrong reaching Buddy.'}`;
    chatHistory[replyIdx].errored=true;
  }finally{
    chatBusy=false; $('chatSend').disabled=false;
    renderChat();
  }
}
$('chatSend').onclick=sendChat;
$('chatInput').onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } };
$('blAsk').onclick=()=>{ S.ui.tab='buddy'; renderAll(); };
$('hotTakesBtn').onclick=()=>{
  S.ui.hotTakes=!S.ui.hotTakes;
  $('hotTakesBtn').classList.toggle('active', S.ui.hotTakes);
  toast(S.ui.hotTakes ? '🔥 Hot takes on' : 'Hot takes off');
};
/* ---------- save / load ---------- */
function openExport(mode){
  $('bottombar').classList.remove('expanded');
  const m=$('exModal'); m.classList.add('open');
  if(mode==='claude'){
    $('exTitle').textContent='Ask Claude — draft state';
    $('exNote').innerHTML='Paste this into your Claude chat for deep analysis of your next pick.';
    $('exText').value=buildClaudeText(); $('exLoad').style.display='none';
  } else if(mode==='cmp'){
    $('exTitle').textContent='Ask Claude — player matchup';
    $('exNote').innerHTML='Paste this into your Claude chat and I\'ll break down which player to take.';
    $('exText').value=buildCompareText(); $('exLoad').style.display='none';
  } else {
    $('exTitle').textContent='Save / load draft';
    $('exNote').innerHTML='<b>Save:</b> copy this code somewhere safe (notes app). <b>Load:</b> paste a saved code below and tap “Load pasted state”. <span style="color:var(--warn)">Note: refreshing the page clears the draft — save first!</span>';
    $('exText').value=JSON.stringify({v:2, S:{...S, ui:undefined}});
    $('exLoad').style.display='block';
  }
}
$('askClaude').onclick=()=>openExport('claude');
$('saveBtn').onclick=()=>openExport('save');
$('bbToggle').onclick=(e)=>{ e.stopPropagation(); $('bottombar').classList.toggle('expanded'); };
document.addEventListener('click', e=>{
  if(!$('bottombar').contains(e.target)) $('bottombar').classList.remove('expanded');
});
$('exClose').onclick=()=>$('exModal').classList.remove('open');
$('exCopy').onclick=async()=>{
  const t=$('exText');
  try{ await navigator.clipboard.writeText(t.value); toast('Copied!'); }
  catch(e){ t.focus(); t.select(); try{document.execCommand('copy'); toast('Copied!');}catch(e2){ toast('Select & copy manually'); } }
};
$('exLoad').onclick=()=>{
  try{
    const data=JSON.parse($('exText').value);
    if(!data.S || !Array.isArray(data.S.actions)) throw 0;
    S={...S, ...data.S, queue:data.S.queue||[], ui:S.ui, started:true};
    rebuildStatus(); showApp(); renderAll();
    $('exModal').classList.remove('open'); toast('Draft restored');
  }catch(e){ toast('Could not read that save code'); }
};
/* ---------- compare wiring ---------- */
$('cmpMode').onclick=()=>{
  S.ui.cmpActive=!S.ui.cmpActive;
  $('cmpMode').classList.toggle('active', S.ui.cmpActive);
  toast(S.ui.cmpActive?'Compare mode: tap players to select':'Compare mode off');
};
$('cmpClear').onclick=()=>{ S.ui.cmp=[]; renderCmpBar(); if(S.ui.tab==='draft') renderBoard(); };
$('cmpOpen').onclick=()=>openCompare();
$('cClose').onclick=()=>$('cModal').classList.remove('open');
$('cModal').onclick=e=>{ if(e.target===$('cModal')) $('cModal').classList.remove('open'); };
$('cAsk').onclick=()=>{ $('cModal').classList.remove('open'); openExport('cmp'); };
/* ---------- settings ---------- */
function renderTeamNamesEditor(count){
  const el=$('mTeamNames'); el.innerHTML='';
  for(let i=1;i<=count;i++){
    const row=document.createElement('div'); row.className='tnrow';
    row.innerHTML=`<span class="tnlab">Team ${i}${i===S.slot?' (you)':''}</span><input type="text" data-team="${i}" placeholder="Team ${i}" value="${escapeHtml(S.teamNames[i]||'')}">`;
    el.appendChild(row);
  }
}
$('setBtn').onclick=()=>{
  if(!S.started){ toast('Finish setup first'); return; }
  fillSelect($('mTeams'),4,20,S.teams); fillSelect($('mSlot'),1,S.teams,S.slot);
  fillSelect($('mRounds'),8,25,S.rounds); $('mPick').value=S.pick;
  window._mreq={...S.req}; reqEditor($('mReq'), window._mreq);
  renderTeamNamesEditor(S.teams);
  $('mTeams').onchange=()=>{
    const n=Number($('mTeams').value);
    fillSelect($('mSlot'),1,n,Math.min(S.slot,n));
    renderTeamNamesEditor(n);
  };
  $('setModal').classList.add('open');
};
$('mCancel').onclick=()=>$('setModal').classList.remove('open');
$('mSave').onclick=()=>{
  S.teams=Number($('mTeams').value); S.slot=Number($('mSlot').value);
  S.rounds=Number($('mRounds').value); S.req={...window._mreq};
  S.pick=Math.max(1,Math.min(totalPicks()+1,Number($('mPick').value)||1));
  const newNames={};
  $('mTeamNames').querySelectorAll('input[data-team]').forEach(inp=>{
    const v=inp.value.trim();
    if(v) newNames[Number(inp.dataset.team)]=v;
  });
  S.teamNames=newNames;
  $('setModal').classList.remove('open'); renderAll(); toast('Settings saved');
};
function resetDraft(){
  if(!confirm('Reset the whole draft? All picks will be cleared.')) return;
  S.actions=[]; S.pick=1; rebuildStatus();
  renderAll(); toast('Draft reset');
}
$('mReset').onclick=()=>{ resetDraft(); $('setModal').classList.remove('open'); };
$('sideResetBtn').onclick=resetDraft;
$('stPick').onclick=()=>{
  const v=prompt('Set current overall pick number (use this if the app got out of sync with the real draft):', S.pick);
  if(v==null) return; const n=Number(v);
  if(n>=1 && n<=totalPicks()+1){ S.pick=Math.round(n); renderAll(); } else toast('Invalid pick number');
};
/* ---------- ui wiring ---------- */
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{ S.ui.tab=b.dataset.tab; renderAll(); });
$('search').oninput=e=>{ S.ui.search=e.target.value; S.ui.shown=50; renderBoard(); };
$('toggleDrafted').onclick=()=>{ S.ui.hideDrafted=!S.ui.hideDrafted;
  $('toggleDrafted').textContent=S.ui.hideDrafted?'Hide drafted':'Show all'; renderBoard(); };
$('showMore').onclick=()=>{ S.ui.shown+=50; renderBoard(); };
(function(){
  const el=$('pfilters');
  for(const pos of ['ALL','RB','WR','QB','TE','FLEX','K','DST']){
    const b=document.createElement('button'); b.className='pf'+(pos==='ALL'?' active':''); b.textContent=pos;
    b.onclick=()=>{ S.ui.pos=pos; S.ui.shown=50;
      el.querySelectorAll('.pf').forEach(x=>x.classList.toggle('active',x===b)); renderBoard(); };
    el.appendChild(b);
  }
})();
/* ---------- draft log filters ---------- */
(function(){
  const el=$('logPosFilters');
  for(const pos of ['ALL','RB','WR','QB','TE','K','DST']){
    const b=document.createElement('button'); b.className='pf'+(pos==='ALL'?' active':''); b.textContent=pos;
    b.onclick=()=>{ S.ui.logPos=pos;
      el.querySelectorAll('.pf').forEach(x=>x.classList.toggle('active',x===b)); renderLog(); };
    el.appendChild(b);
  }
})();
$('logSearch').oninput=e=>{ S.ui.logQ=e.target.value; renderLog(); };
$('logTeamFilter').onchange=e=>{ S.ui.logTeam=e.target.value; renderLog(); };
$('logSortDesc').onclick=()=>{ S.ui.logSort='desc';
  $('logSortDesc').classList.add('active'); $('logSortAsc').classList.remove('active'); renderLog(); };
$('logSortAsc').onclick=()=>{ S.ui.logSort='asc';
  $('logSortAsc').classList.add('active'); $('logSortDesc').classList.remove('active'); renderLog(); };
$('logExport').onclick=()=>openExport('claude');
/* ---------- setup screen ---------- */
fillSelect($('suTeams'),4,20,10); fillSelect($('suSlot'),1,10,5); fillSelect($('suRounds'),8,25,15);
$('suTeams').onchange=()=>fillSelect($('suSlot'),1,Number($('suTeams').value),1);
window._sureq={...DEF_REQ}; reqEditor($('suReq'), window._sureq);
$('suStart').onclick=()=>{
  S.teams=Number($('suTeams').value); S.slot=Number($('suSlot').value);
  S.rounds=Number($('suRounds').value); S.req={...window._sureq};
  S.started=true; S.pick=1;
  showApp(); renderAll(); toast('Draft on — good luck! 🍀');
};
function showApp(){
  $('setupView').style.display='none';
  $('statusbar').style.display='flex'; $('tabsScroll').style.display='block'; $('bottombar').style.display='block';
  $('simBtn').style.display=''; $('simToMineBtn').style.display='';
  $('wrap').classList.add('two-pane');
}
initCloudAuth();
