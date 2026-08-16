"use strict";
/* ---------- state ---------- */
let S = {
  started:false, teams:10, slot:5, rounds:15, req:{...DEF_REQ},
  pick:1,                    // current overall pick about to be made
  actions:[],                // [{id, kind:'taken'|'mine', pick}]
  queue:[],                  // starred player ids, in priority order
  ui:{tab:'draft', pos:'ALL', search:'', hideDrafted:true, shown:50, cmp:[], cmpActive:false}
};
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
  $('stClock').textContent = done ? '—' : (mine ? 'YOU' : 'Team '+teamOnClock(S.pick));
  $('stClockLab').textContent = mine ? 'Your pick!' : 'On the clock';
  const nxt = nextMyPicks(1);
  $('stNext').textContent = nxt.length? '#'+nxt[0] : '—';
  $('subhdr').textContent = `${S.teams}-team PPR snake · slot ${S.slot} · Rd ${Math.min(roundOf(Math.min(S.pick,totalPicks())),S.rounds)}/${S.rounds}`;
}
function pcardInfoHtml(p, opts){
  opts=opts||{};
  const bye = p.b ? `Bye ${p.b}` : 'FA';
  const chipsHtml = opts.chips ? `<div class="pcard-chips">${opts.chips}</div>` : '';
  return `<div class="pcard-name">${p.n}${opts.nameExtra||''}${injuryBadgeHtml(p.id)}</div>
    <div class="pcard-meta"><span class="posbadge ${posColor(p.p)}">${p.p}${p.pr}</span>${teamLogoHtml(p.t)}${p.t} · ${bye} · <span title="${ADP_TOOLTIP}">ADP ${p.adp}</span> · <span class="tierb">Tier ${tiers[p.id]}</span></div>
    ${chipsHtml}`;
}
function queueStarHtml(id){ return inQueue(id) ? ' <span style="color:var(--queue)">★</span>' : ''; }
function playerRow(p){
  const st = status[p.id];
  const row=document.createElement('div');
  row.className='pcard'+(st==='taken'?' gone':'')+(st==='mine'?' mine':'')
    +(S.ui.cmp.includes(p.id)?' cmpsel':'');
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
  $('recHdr').textContent = mine ? '🎯 Your pick — best options' : 'Best available (planning ahead)';
  const recs=recommend(5);
  recs.forEach((r,i)=>{
    const d=document.createElement('div'); d.className='pcard'+(i===0?' top':'');
    const chips=r.reasons.slice(0,3).map(x=>`<span class="chip ${x.c}">${x.t}</span>`).join('');
    d.innerHTML=`<div class="pcard-top">
        <div class="pcard-rank">${i+1}</div>
        ${avatarHtml(r.p)}
        <div class="pcard-info">${pcardInfoHtml(r.p,{nameExtra:queueStarHtml(r.p.id), chips})}</div>
      </div>
      <div class="pcard-actions"></div>`;
    d.querySelector('.pcard-info').onclick=()=>openPlayer(r.p.id);
    const actions=d.querySelector('.pcard-actions');
    actions.appendChild(starButton(r.p.id));
    const b1=document.createElement('button'); b1.className='btn taken'; b1.textContent='Taken';
    b1.onclick=()=>mark(r.p.id,'taken');
    const b2=document.createElement('button'); b2.className='btn mine'; b2.textContent='Me';
    b2.onclick=()=>mark(r.p.id,'mine');
    actions.appendChild(b1); actions.appendChild(b2);
    el.appendChild(d);
  });
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
      [S.queue[i],S.queue[j]]=[S.queue[j],S.queue[i]]; renderQueue();
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
      <div class="fact" title="${ADP_TOOLTIP}"><div class="v">${p.adp}</div><div class="l">ADP</div></div>
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
    btns.innerHTML=`<div class="note" style="flex:1;text-align:center">${st==='mine'?'On your roster':'Drafted by Team '+teamOnClock(a.pick)} — pick #${a.pick}</div>`;
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
  $('cmpBar').classList.toggle('show', c.length>0);
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
    +rowH(`<span title="${ADP_TOOLTIP}">ADP</span>`, info.map(x=>x.p.adp), -1)
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
function renderLog(){
  const el=$('log'); el.innerHTML='';
  [...S.actions].reverse().forEach(a=>{
    const p=PLAYERS.find(x=>x.id===a.id);
    const d=document.createElement('div'); d.className='logrow';
    d.innerHTML=`<div class="logpick">#${a.pick} R${roundOf(a.pick)}</div>
      ${avatarHtml(p,'sm')}
      <span class="posbadge ${posColor(p.p)}">${p.p}</span>
      <div style="flex:1; min-width:0">${p.n}${injuryBadgeHtml(p.id)} <span style="color:var(--dim);font-size:12px">${teamLogoHtml(p.t)}${p.t}</span></div>
      <div style="font-size:11px;font-weight:800;color:${a.kind==='mine'?'var(--me)':'var(--dim)'}">${a.kind==='mine'?'YOU':'Team '+teamOnClock(a.pick)}</div>`;
    el.appendChild(d);
  });
  if(!S.actions.length) el.innerHTML=`<div class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">No picks yet</div>
      <div class="empty-sub">Every pick will show up here as the draft goes.</div>
    </div>`;
}
function renderDraftBoard(){
  const el=$('dbGrid');
  el.style.gridTemplateColumns=`34px repeat(${S.teams},1fr)`;
  let html='<div class="dbcell dbcorner"></div>';
  for(let t=1;t<=S.teams;t++){
    const mine=t===S.slot;
    html+=`<div class="dbcell dbhead${mine?' dbmine':''}">${mine?'YOU':'T'+t}</div>`;
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
        html+=`<div class="dbcell dbempty${mine?' dbmine':''}${isClock?' dbclock':''}">${isClock?'●':'·'}</div>`;
      }
    }
  }
  el.innerHTML=html;
  el.querySelectorAll('.dbpick').forEach(c=>{ c.onclick=()=>openPlayer(Number(c.dataset.id)); });
}
function renderAll(){
  renderStatus();
  const t=S.ui.tab;
  $('draftView').style.display = t==='draft'?'block':'none';
  $('boardView').style.display = t==='board'?'block':'none';
  $('queueView').style.display = t==='queue'?'block':'none';
  $('teamView').style.display = t==='team'?'block':'none';
  $('logView').style.display = t==='log'?'block':'none';
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===t));
  const avail=S.queue.filter(id=>!status[id]).length;
  $('qCount').style.display = avail? 'inline-block':'none';
  $('qCount').textContent = avail;
  if(t==='draft'){ renderRecs(); renderBoard(); }
  if(t==='board') renderDraftBoard();
  if(t==='queue') renderQueue();
  if(t==='team') renderTeam();
  if(t==='log') renderLog();
}
/* ---------- actions ---------- */
function mark(id, kind){
  if(status[id]) return;
  if(S.pick>totalPicks()){ toast('Draft is complete'); return; }
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
/* ---------- save / load ---------- */
function openExport(mode){
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
$('setBtn').onclick=()=>{
  if(!S.started){ toast('Finish setup first'); return; }
  fillSelect($('mTeams'),4,20,S.teams); fillSelect($('mSlot'),1,S.teams,S.slot);
  fillSelect($('mRounds'),8,25,S.rounds); $('mPick').value=S.pick;
  window._mreq={...S.req}; reqEditor($('mReq'), window._mreq);
  $('mTeams').onchange=()=>fillSelect($('mSlot'),1,Number($('mTeams').value),Math.min(S.slot,Number($('mTeams').value)));
  $('setModal').classList.add('open');
};
$('mCancel').onclick=()=>$('setModal').classList.remove('open');
$('mSave').onclick=()=>{
  S.teams=Number($('mTeams').value); S.slot=Number($('mSlot').value);
  S.rounds=Number($('mRounds').value); S.req={...window._mreq};
  S.pick=Math.max(1,Math.min(totalPicks()+1,Number($('mPick').value)||1));
  $('setModal').classList.remove('open'); renderAll(); toast('Settings saved');
};
$('mReset').onclick=()=>{
  if(!confirm('Reset the whole draft? All picks will be cleared.')) return;
  S.actions=[]; S.pick=1; rebuildStatus();
  $('setModal').classList.remove('open'); renderAll(); toast('Draft reset');
};
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
}
