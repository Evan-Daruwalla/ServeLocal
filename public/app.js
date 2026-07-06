/* ServeLocal SPA — extracted from public/index.html (ADR-0014).
 * Loaded with <script src="/app.js" defer>: executes after DOM parse, so all
 * elements exist by the time top-level init code runs (same guarantee the
 * end-of-body inline block used to have). Twemojify IIFE appended at the end,
 * preserving the original execution order. */

const API = '';
let currentUser = null;
let token = localStorage.getItem('sl_token') || null;
let allOpps = [];
let oppsRawCount = 0, oppsTotal = 0; // pagination bookkeeping (ADR-0013 — server caps /api/opportunities to a page)
let myHours = [];
let myApps = [];
let hoursFilter = 'all';
let calYear, calMonth;
let currentOppId = null;
let oppOriginView = null;
let currentReportOrgId = null;
let currentChatOppId = null;
let searchTimer = null;
let zipCoords = null; // {lat, lng, city, state, zip} when set

const SKILLS = ['Tutoring','Communication','Teamwork','Gardening','Animal Care','Social Media','Graphic Design','Technology','Physical Activity','STEM','Writing','Organization','Mentorship','Creativity','Data Entry','Research','Leadership','First Aid','Languages','Customer Service','Other'];
const CAUSES = ['Education','Environment','Animals','Food & Hunger','Health','Arts & Culture','Children & Youth','Elderly Care','Community','STEM','Mental Health','Immigration'];
const FREE_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','protonmail.com','mail.com','zoho.com','yandex.com','live.com','msn.com','me.com']);

// ── API ───────────────────────────────────────
// Resilient client: retry-with-backoff for idempotent GETs and transient
// failures, automatic session-expiry handling, and Idempotency-Key support so
// a retried mutation can never double-apply on the server.
let _sessionExpiredHandled = false;
function uuid(){ return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2)); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function api(endpoint, opts={}) {
  const method = (opts.method||'GET').toUpperCase();
  const isIdempotent = method==='GET' || opts.idempotent;
  const hdrs = {'Content-Type':'application/json'};
  if (token) hdrs['Authorization'] = 'Bearer '+token;
  // Attach a stable Idempotency-Key for mutating calls so retries are safe.
  if (method!=='GET' && !(opts.headers&&opts.headers['Idempotency-Key'])) {
    hdrs['Idempotency-Key'] = opts.idempotencyKey || uuid();
  }
  const maxAttempts = isIdempotent ? 3 : 1;
  let lastErr;
  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(API+endpoint, {...opts, headers:{...hdrs,...(opts.headers||{})}});
    } catch (netErr) {
      // Network/connection failure — retry idempotent calls with backoff.
      lastErr = new Error('Network error — check your connection');
      if (attempt<maxAttempts) { await sleep(300*attempt); continue; }
      throw lastErr;
    }
    // Session expired / revoked: log out once and stop.
    if (res.status===401 && token && endpoint!=='/api/auth/login') {
      handleSessionExpired();
      let d={}; try{ d=await res.json(); }catch{}
      throw new Error(d.error||'Session expired');
    }
    // Transient server states — back off and retry idempotent calls.
    if ((res.status===429||res.status===502||res.status===503||res.status===504) && attempt<maxAttempts && isIdempotent) {
      const ra = parseFloat(res.headers.get('retry-after'))||(0.4*attempt);
      await sleep(ra*1000);
      continue;
    }
    let data={}; try{ data=await res.json(); }catch{}
    if (!res.ok) { const e=new Error(data.error||'Request failed'); e.code=data.code; throw e; }
    return opts.raw ? {data, headers:res.headers} : data;
  }
  throw lastErr||new Error('Request failed');
}

function handleSessionExpired(){
  if (_sessionExpiredHandled || !currentUser) return;
  _sessionExpiredHandled = true;
  toast('Your session expired — please log in again','err');
  logout();
  setTimeout(()=>{ _sessionExpiredHandled=false; }, 1500);
}

// ── INIT ──────────────────────────────────────
async function init() {
  const d = new Date(); calYear=d.getFullYear(); calMonth=d.getMonth();
  loadStats();
  initChips();
  if (token) { try { const u = await api('/api/auth/me'); setUser(u); } catch { token=null; localStorage.removeItem('sl_token'); } }
  if (location.hash.length>1) routeFromHash();
  maybeShowStorageNotice();
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    setText('stat-opps', s.opportunities);
    setText('stat-students', s.students.toLocaleString());
    setText('stat-hours', (s.totalHours||0).toLocaleString()+'+');
  } catch {}
}

function setUser(u) {
  currentUser = u;
  const area = document.getElementById('nav-right');
  const init = u.role==='org' ? (u.orgName||'O').charAt(0).toUpperCase() : (u.firstName||'U').charAt(0).toUpperCase();
  const name = u.role==='org' ? u.orgName : u.firstName;
  area.innerHTML = `
    <div class="notif-bell-wrap">
      <div class="notif-bell" role="button" tabindex="0" aria-label="Notifications" data-keydown="toggleNotifKey" data-action="toggleNotifPanel">
        🔔<span class="notif-badge" id="notif-badge" style="display:none">0</span>
      </div>
      <div class="notif-panel" id="notif-panel">
        <div class="notif-hdr"><h4>Notifications</h4><button data-action="markAllNotifRead">Mark all read</button></div>
        <div class="notif-list" id="notif-list"><div class="notif-empty">No notifications yet</div></div>
      </div>
    </div>
    <div class="nav-chip" data-action="${u.role==='admin'?'goAdmin':u.role==='org'?'goOrgDash':'goStudentDash'}">
      <div class="nav-avatar">${esc(init)}</div>${esc(name)}
    </div>
    <button class="nav-btn nb-outline" data-action="logout">Log Out</button>`;
  startNotifPolling();
  updateNav(u.role);

  if (u.role==='student') {
    document.getElementById('support-banner').style.display='block';
    setNavActive('nl-dash');
    updateGuardianConsentBanner(u);
  } else if (u.role==='org') {
    setNavActive('nl-org');
    setText('ods-name', u.orgName);
    setText('ods-avatar', init);
    if (document.getElementById('org-desc-edit')) document.getElementById('org-desc-edit').value = u.description||'';
    if (document.getElementById('org-website-edit')) document.getElementById('org-website-edit').value = u.website||'';
  }
}

function logout() {
  currentUser=null; token=null; localStorage.removeItem('sl_token');
  stopNotifPolling();
  document.getElementById('nav-right').innerHTML = `<button class="nav-btn nb-outline" data-action="openAuth" data-args='["login"]'>Log In</button><button class="nav-btn nb-solid" data-action="openAuth" data-args='["register"]'>Sign Up Free</button>`;
  updateNav(null);
  document.getElementById('support-banner').style.display='none';
  document.getElementById('guardian-consent-banner').style.display='none';
  nav('home');
  toast('Logged out');
}

// Reflects the current student's guardianConsentStatus in the persistent banner.
// 'verified' and 'not_required' (18+) show nothing — see docs/guardian-consent-spec.md.
function updateGuardianConsentBanner(u) {
  const banner = document.getElementById('guardian-consent-banner');
  const text = document.getElementById('guardian-consent-banner-text');
  const btn = document.getElementById('guardian-consent-resend-btn');
  const status = u.guardianConsentStatus;
  if (status==='pending'||status==='legacy_pending') {
    text.textContent = `We emailed ${u.guardianName||'your parent/guardian'} for approval — you can browse opportunities now, but can't sign up for one until they respond.`;
    btn.style.display='inline-block';
    banner.style.display='block';
  } else if (status==='declined'||status==='revoked') {
    text.textContent = `Your parent/guardian ${status==='declined'?'declined':'revoked'} approval for your ServeLocal account. Contact support@servelocal.org for help.`;
    btn.style.display='none';
    banner.style.display='block';
  } else {
    banner.style.display='none';
  }
}

async function resendGuardianConsent() {
  const btn = document.getElementById('guardian-consent-resend-btn');
  btn.disabled = true;
  try {
    await api('/api/account/consent/resend',{method:'POST',body:'{}'});
    toast('Approval email resent.');
  } catch(e) { toast(e.message,'err'); }
  finally { btn.disabled = false; }
}

// ── NOTIFICATIONS ───────────────────────────
let _notifInterval = null, _notifVisBound = false;
function startNotifPolling() {
  stopNotifPolling();
  pollNotifCount();
  _notifInterval = setInterval(pollNotifCount, 30000);
  // Pause polling while the tab is hidden and catch up the moment it's foregrounded again.
  // A backgrounded tab shouldn't keep hitting the server every 30s (saves request volume at
  // scale); pollNotifCount() already no-ops on document.hidden, this just refreshes on return.
  if (!_notifVisBound) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pollNotifCount();
    });
    _notifVisBound = true;
  }
}
function stopNotifPolling() {
  if (_notifInterval) { clearInterval(_notifInterval); _notifInterval=null; }
  const panel = document.getElementById('notif-panel');
  if (panel) panel.classList.remove('open');
}
async function pollNotifCount() {
  if (!currentUser) return;
  if (document.hidden) return; // skip network/server work while tab is backgrounded
  try {
    const d = await api('/api/notifications/unread-count');
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (d.count > 0) { badge.style.display='flex'; badge.textContent=d.count>99?'99+':d.count; }
    else { badge.style.display='none'; }
  } catch {}
}
function toggleNotifPanel(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('notif-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) loadNotifications();
}
async function loadNotifications() {
  try {
    const d = await api('/api/notifications');
    const list = document.getElementById('notif-list');
    if (!d.notifications.length) { list.innerHTML='<div class="notif-empty">No notifications yet</div>'; return; }
    const icons = {app_approved:'✅',app_rejected:'❌',hours_verified:'✅',hours_denied:'❌',new_message:'💬',event_reminder_24h:'⏰',event_reminder_1h:'🔔',saved_search_match:'🔍',hours_verification_needed:'📋',waitlist_promoted:'🎉'};
    list.innerHTML = d.notifications.map(n=>`
      <div class="notif-item ${n.read?'read':'unread'}" data-action="onNotifClick" data-args="${esc(JSON.stringify([n.id, n.link||'']))}">
        <span class="notif-icon">${icons[n.type]||'📢'}</span>
        <div class="notif-body">
          <div class="notif-title">${esc(n.title)}</div>
          <div class="notif-msg">${esc(n.message)}</div>
          <div class="notif-time">${timeAgo(n.createdAt)}</div>
        </div>
      </div>`).join('');
  } catch {}
}
async function onNotifClick(id, link) {
  try { await api('/api/notifications/'+id+'/read',{method:'PATCH'}); } catch {}
  pollNotifCount();
  document.getElementById('notif-panel').classList.remove('open');
  if (link.startsWith('chat:')) {
    const oppId = link.split(':')[1];
    const opp = allOpps.find(o=>o.id===oppId);
    openChat(oppId, opp?.title||'Chat');
  } else if (link==='dash') {
    nav('dash'); loadStudentDash();
  } else if (link==='discover') {
    nav('discover'); loadOpps();
  } else if (link==='org-hours') {
    nav('org-dash'); loadOrgDash();
    // Switch to Verify Hours tab after a short delay for DOM readiness
    setTimeout(()=>{
      const hoursTab = document.getElementById('otab-hours');
      if(hoursTab){ switchOrgDash('hours',hoursTab); loadOrgHours(); }
    },300);
  }
}
async function markAllNotifRead() {
  try { await api('/api/notifications/read-all',{method:'PATCH'}); } catch {}
  pollNotifCount();
  loadNotifications();
}
function timeAgo(iso) {
  const s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if (s<60) return 'just now';
  if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
// Close notif panel when clicking outside
document.addEventListener('click', e => {
  const panel = document.getElementById('notif-panel');
  if (panel?.classList.contains('open') && !e.target.closest('.notif-bell-wrap')) panel.classList.remove('open');
});

// ── ENDORSEMENTS ──────────────────────────────
let _endorseState = {};
function openEndorseModal(userId, userName, oppId, oppTitle) {
  _endorseState = {userId, oppId};
  document.getElementById('endorse-sub').textContent = 'For '+userName+' — '+oppTitle;
  document.getElementById('endorse-skills-chips').innerHTML = SKILLS.map(s=>`<span class="chip" data-action="toggleOn">${s}</span>`).join('');
  document.getElementById('endorse-err').textContent='';
  openM('endorse-overlay');
}
async function submitEndorsement() {
  const skills = Array.from(document.querySelectorAll('#endorse-skills-chips .chip.on')).map(c=>c.textContent);
  if (!skills.length) { document.getElementById('endorse-err').textContent='Select at least one skill'; return; }
  try {
    await api('/api/endorsements',{method:'POST',body:JSON.stringify({userId:_endorseState.userId,oppId:_endorseState.oppId,skills})});
    closeM('endorse-overlay');
    toast('Endorsement submitted!');
  } catch(e) { document.getElementById('endorse-err').textContent=e.message; }
}
async function loadEndorsements(userId) {
  try {
    const d = await api('/api/endorsements/'+userId);
    const el = document.getElementById('endorsed-skills-section');
    if (!el) return;
    if (!d.endorsements.length) { el.innerHTML='<p style="color:var(--muted);font-size:.83rem">No endorsements yet. Organizations can endorse your skills after you volunteer.</p>'; return; }
    const sorted = Object.entries(d.skillCounts).sort((a,b)=>b[1]-a[1]);
    el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px">'+sorted.map(([skill,count])=>`<div style="display:flex;align-items:center;gap:6px;background:var(--green-pale);border:1px solid var(--green-mid);padding:6px 12px;border-radius:100px;font-size:.78rem;font-weight:600;color:var(--green)"><span>${esc(skill)}</span><span style="background:var(--green);color:#fff;padding:1px 6px;border-radius:100px;font-size:.65rem">×${count}</span></div>`).join('')+'</div>';
  } catch {}
}

// ── PORTFOLIO ────────────────────────────────
async function loadPortfolio(userId) {
  pushHash('portfolio/'+userId);
  try {
    const d = await api('/api/portfolio/'+userId);
    const el = document.getElementById('portfolio-content');
    const awardHtml = d.awards.length?d.awards.map(a=>`<span style="display:inline-flex;align-items:center;gap:4px;background:var(--green-pale);border:1px solid var(--green-mid);padding:6px 12px;border-radius:100px;font-size:.78rem;font-weight:600;color:var(--green)">🏆 ${esc(a.name)}</span>`).join(' '):'<span style="color:var(--muted);font-size:.83rem">No awards yet</span>';
    const orgHtml = Object.entries(d.hoursByOrg).sort((a,b)=>b[1]-a[1]).map(([org,hrs])=>`<tr><td style="font-weight:500">${esc(org)}</td><td style="text-align:right;font-weight:600;color:var(--green)">${hrs} hrs</td></tr>`).join('');
    const skillHtml = Object.entries(d.skillCounts||{}).sort((a,b)=>b[1]-a[1]).map(([s,c])=>`<span style="display:inline-flex;align-items:center;gap:4px;background:#e0f2ff;padding:5px 10px;border-radius:100px;font-size:.75rem;font-weight:600;color:#0369a1">${esc(s)} <span style="background:#0369a1;color:#fff;padding:0 5px;border-radius:100px;font-size:.6rem">×${c}</span></span>`).join(' ');
    el.innerHTML = `
      <div style="text-align:center;margin-bottom:28px" id="portfolio-header">
        <h2 style="font-size:1.6rem;color:var(--dark);margin-bottom:4px">${esc(d.name)}</h2>
        <p style="color:var(--muted);font-size:.88rem">${esc(d.school||'')}${d.grade?' · '+esc(d.grade):''}</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:28px;text-align:center">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px">
          <div style="font-size:1.8rem;font-weight:700;color:var(--green)">${d.totalVerifiedHours}</div>
          <div style="font-size:.78rem;color:var(--muted)">Verified Hours</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px">
          <div style="font-size:1.8rem;font-weight:700;color:var(--green)">${d.uniqueOrgs}</div>
          <div style="font-size:.78rem;color:var(--muted)">Organizations</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px">
          <div style="font-size:1.8rem;font-weight:700;color:var(--green)">${d.awards.length}</div>
          <div style="font-size:.78rem;color:var(--muted)">Awards Earned</div>
        </div>
      </div>
      <div style="margin-bottom:24px"><h4 style="font-size:.92rem;color:var(--dark);margin-bottom:10px">Hours by Organization</h4>
        <table class="tbl" style="font-size:.85rem"><tbody>${orgHtml||'<tr><td style="color:var(--muted)">No verified hours yet</td></tr>'}</tbody></table>
      </div>
      ${skillHtml?`<div style="margin-bottom:24px"><h4 style="font-size:.92rem;color:var(--dark);margin-bottom:10px">🌟 Endorsed Skills</h4><div style="display:flex;flex-wrap:wrap;gap:8px">${skillHtml}</div></div>`:''}
      <div style="margin-bottom:24px"><h4 style="font-size:.92rem;color:var(--dark);margin-bottom:10px">🏆 Awards</h4><div style="display:flex;flex-wrap:wrap;gap:8px">${awardHtml}</div></div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:20px" id="portfolio-actions">
        <button class="btn-s" style="padding:10px 20px" data-action="printWindow">🖨 Print</button>
        <button class="btn-s" style="padding:10px 20px" data-action="copyPortfolioLink">🔗 Copy Link</button>
      </div>`;
  } catch(e) {
    document.getElementById('portfolio-content').innerHTML = '<div class="empty"><div class="empty-icon">🔒</div>'+(e.message||'Portfolio not available')+'</div>';
  }
}
function viewMyPortfolio() {
  if (!currentUser) return;
  nav('portfolio');
  loadPortfolio(currentUser.id);
}
async function togglePortfolioVisibility(pub) {
  try {
    await api('/api/portfolio/visibility',{method:'PATCH',body:JSON.stringify({public:pub})});
    currentUser.portfolioPublic = pub;
    toast(pub?'Portfolio is now public':'Portfolio is now private');
  } catch(e) { toast(e.message,'err'); }
}
function copyPortfolioLink() {
  if (!currentUser) return;
  const url = location.origin+'/#portfolio/'+currentUser.id;
  navigator.clipboard.writeText(url).then(()=>toast('Link copied!')).catch(()=>toast('Could not copy','err'));
}

// ── IMPACT DASHBOARD ────────────────────────
async function loadImpact() {
  const el = document.getElementById('impact-content');
  el.innerHTML='<div class="loading"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    const d = await api('/api/impact');
    const maxMonth = Math.max(...d.hoursByMonth.map(m=>m.hours),1);
    const maxCat = Math.max(...d.hoursByCategory.map(c=>c.hours),1);
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:var(--green)">${d.totalHours}</div>
          <div style="font-size:.73rem;color:var(--muted)">Total Hours</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:var(--green)">Top ${100-d.percentileRank}%</div>
          <div style="font-size:.73rem;color:var(--muted)">Ranking</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:var(--green)">${d.totalOrgs}</div>
          <div style="font-size:.73rem;color:var(--muted)">Organizations</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center">
          <div style="font-size:1.6rem;font-weight:700;color:var(--green)">${d.currentStreak}w</div>
          <div style="font-size:.73rem;color:var(--muted)">Current Streak</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div>
          <h4 style="font-size:.88rem;color:var(--dark);margin-bottom:12px">Hours by Month</h4>
          ${d.hoursByMonth.length?d.hoursByMonth.map(m=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:.72rem;color:var(--muted);width:55px;flex-shrink:0">${m.month}</span>
            <div style="flex:1;background:var(--border);border-radius:4px;height:18px;overflow:hidden"><div style="height:100%;background:linear-gradient(90deg,var(--green),var(--green-l));border-radius:4px;width:${Math.round(m.hours/maxMonth*100)}%;transition:width .5s"></div></div>
            <span style="font-size:.72rem;font-weight:600;color:var(--dark);width:35px;text-align:right">${m.hours}h</span>
          </div>`).join(''):'<p style="color:var(--muted);font-size:.83rem">No data yet</p>'}
        </div>
        <div>
          <h4 style="font-size:.88rem;color:var(--dark);margin-bottom:12px">Hours by Category</h4>
          ${d.hoursByCategory.length?d.hoursByCategory.map(c=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:.72rem;color:var(--muted);width:70px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.category)}</span>
            <div style="flex:1;background:var(--border);border-radius:4px;height:18px;overflow:hidden"><div style="height:100%;background:linear-gradient(90deg,#0369a1,#38bdf8);border-radius:4px;width:${Math.round(c.hours/maxCat*100)}%;transition:width .5s"></div></div>
            <span style="font-size:.72rem;font-weight:600;color:var(--dark);width:35px;text-align:right">${c.hours}h</span>
          </div>`).join(''):'<p style="color:var(--muted);font-size:.83rem">No data yet</p>'}
        </div>
      </div>
      <div style="margin-top:20px;text-align:center;font-size:.78rem;color:var(--muted)">Longest streak: ${d.longestStreak} weeks · ${d.totalEvents} verified entries</div>`;
  } catch(e) { el.innerHTML='<div class="empty">Could not load impact data.</div>'; }
}

// ── RECOMMENDATIONS ─────────────────────────
async function loadRecommendations() {
  if (!currentUser||currentUser.role!=='student') { hide('recs-section'); return; }
  try {
    const recs = await api('/api/recommendations');
    const sec = document.getElementById('recs-section');
    if (!recs.length) { sec.style.display='none'; return; }
    sec.style.display='';
    const maxScore = Math.max(...recs.map(r=>r.matchScore),1);
    document.getElementById('recs-scroll').innerHTML = recs.map(o=>{
      const pct = Math.round(o.matchScore/maxScore*100);
      return `<div style="min-width:260px;flex-shrink:0;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;position:relative;transition:border-color .15s" data-mouseover="borderGreen" data-mouseout="borderClear" data-action="openOpp" data-args="${esc(JSON.stringify([o.id]))}">
        <div style="position:absolute;top:10px;right:10px;background:var(--green);color:#fff;padding:3px 8px;border-radius:100px;font-size:.65rem;font-weight:700">${pct}% match</div>
        <div style="font-weight:600;font-size:.85rem;color:var(--dark);margin-bottom:4px;padding-right:60px">${esc(o.title)}</div>
        <div style="font-size:.75rem;color:var(--green);margin-bottom:6px">${esc(o.orgName)}</div>
        <div style="font-size:.72rem;color:var(--muted)">${esc(o.commitment)} · ${fmt(o.durationHours)} hrs · ${o.spotsRemaining} spots</div>
      </div>`;
    }).join('');
  } catch { document.getElementById('recs-section').style.display='none'; }
}

// ── QUICK LOG ───────────────────────────────
function renderQuickLog() {
  const sec = document.getElementById('quick-log-section');
  const list = document.getElementById('quick-log-list');
  if (!sec||!list) return;
  // Find recurring opps the student has logged hours for
  const recurringHours = myHours.filter(h=>{
    const opp = allOpps.find(o=>o.id===h.oppId);
    return opp&&(opp.commitment==='Weekly'||opp.commitment==='Monthly');
  });
  if (!recurringHours.length) { sec.style.display='none'; return; }
  // Group by oppId, take latest
  const byOpp = {};
  recurringHours.forEach(h=>{ if(!byOpp[h.oppId]||h.createdAt>byOpp[h.oppId].createdAt) byOpp[h.oppId]=h; });
  sec.style.display='';
  list.innerHTML = Object.values(byOpp).map(h=>{
    const opp = allOpps.find(o=>o.id===h.oppId);
    const shift = opp?.commitment==='Monthly'?30:7;
    return `<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;min-width:220px;flex:1;max-width:300px">
      <div style="font-weight:600;font-size:.82rem;color:var(--dark);margin-bottom:3px">${esc(h.activity)}</div>
      <div style="font-size:.73rem;color:var(--muted);margin-bottom:8px">${esc(h.orgName)} · ${fmt(h.hours)} hrs · ${opp?.commitment||''}</div>
      <button class="btn-s" style="padding:6px 12px;font-size:.75rem;width:100%" data-action="quickLog" data-args="${esc(JSON.stringify([h.id, shift]))}">⚡ Log +${shift}d from ${fmtDate(h.startTime)}</button>
    </div>`;
  }).join('');
}
async function quickLog(hourId, shiftDays) {
  const h = myHours.find(x=>x.id===hourId);
  if (!h) return;
  const newStart = new Date(new Date(h.startTime).getTime()+shiftDays*864e5).toISOString();
  const newEnd = new Date(new Date(h.endTime).getTime()+shiftDays*864e5).toISOString();
  try {
    await api('/api/hours',{method:'POST',body:JSON.stringify({oppId:h.oppId,orgName:h.orgName,activity:h.activity,startTime:newStart,endTime:newEnd,notes:h.notes,type:h.oppId?'opp':'self'})});
    await loadMyHours();
    renderQuickLog();
    toast('Hours logged! ⚡');
  } catch(e) { toast(e.message,'err'); }
}

// ── SAVED SEARCHES ──────────────────────────
async function loadSavedSearches() {
  if (!currentUser||currentUser.role!=='student') return;
  try {
    const searches = await api('/api/saved-searches');
    const bar = document.getElementById('saved-searches-bar');
    const list = document.getElementById('saved-searches-list');
    if (!searches.length) { bar.style.display='none'; }
    else {
      bar.style.display='';
      _savedSearchCache = searches;
      list.innerHTML = searches.map(s=>`<span style="display:inline-flex;align-items:center;gap:4px;background:var(--green-pale);border:1px solid var(--green-mid);padding:4px 10px;border-radius:100px;font-size:.72rem;font-weight:600;color:var(--green);cursor:pointer" data-action="applySavedSearchById" data-args="${esc(JSON.stringify([s.id]))}">${esc(s.name)} <span style="cursor:pointer;margin-left:2px;opacity:.6" data-action="deleteSavedSearch" data-stop data-args="${esc(JSON.stringify([s.id]))}">✕</span></span>`).join('');
    }
  } catch {}
  // Show/hide save button
  const btn = document.getElementById('save-search-btn');
  if (btn) btn.style.display = currentUser?.role==='student'?'':'none';
}
async function saveSearch() {
  const name = val('ss-name');
  if (!name) { toast('Enter a name','err'); return; }
  try {
    await api('/api/saved-searches',{method:'POST',body:JSON.stringify({name,query:val('opp-q'),category:val('f-cat'),commitment:val('f-commit'),format:val('f-format')})});
    closeM('save-search-overlay');
    toast('Search saved!');
    loadSavedSearches();
  } catch(e) { toast(e.message,'err'); }
}
let _savedSearchCache = [];
function applySavedSearchById(id) {
  const s = _savedSearchCache.find(x=>x.id===id);
  if (s) applySavedSearch(s);
}
function applySavedSearch(s) {
  if (document.getElementById('opp-q')) document.getElementById('opp-q').value=s.query||'';
  if (document.getElementById('f-cat')) document.getElementById('f-cat').value=s.category||'';
  if (document.getElementById('f-commit')) document.getElementById('f-commit').value=s.commitment||'';
  if (document.getElementById('f-format')) document.getElementById('f-format').value=s.format||'';
  loadOpps();
}
async function deleteSavedSearch(id) {
  try {
    await api('/api/saved-searches/'+id,{method:'DELETE'});
    loadSavedSearches();
    toast('Search removed');
  } catch(e) { toast(e.message,'err'); }
}

function requireAuth(cb) {
  if (currentUser) { cb(); return; }
  openAuth('login'); toast('Please log in first','err');
}

// ── NAVIGATION ────────────────────────────────
function updateNav(role) {
  // Orgs don't browse volunteering; hide that link and relabel Dashboard
  const discoverBtn = document.getElementById('nl-discover');
  const dashBtn = document.getElementById('nl-dash');
  if (role === 'org') {
    if (discoverBtn) discoverBtn.style.display = 'none';
    if (dashBtn) dashBtn.textContent = 'My Dashboard';
  } else {
    if (discoverBtn) discoverBtn.style.display = '';
    if (dashBtn) dashBtn.textContent = 'Dashboard';
  }
}

function nav(view) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const el = document.getElementById('view-'+view);
  if (el) el.classList.add('active');
  window.scrollTo(0,0);
  const navMap = {home:'nl-home',discover:'nl-discover',dash:'nl-dash','org-dash':'nl-org','org-info':'nl-org','org-landing':'nl-org',portfolio:'nl-dash',pricing:'nl-org',community:'nl-community',donate:'nl-donate'};
  setNavActive(navMap[view]||null);
  const HASHABLE = {home:'',discover:'discover',dash:'dash','org-dash':'org-dash','org-info':'org-info',pricing:'pricing',community:'community',donate:'donate',admin:'admin',privacy:'privacy',terms:'terms'};
  if (view in HASHABLE) pushHash(HASHABLE[view]);
}
function setNavActive(id) {
  document.querySelectorAll('.nl').forEach(l=>l.classList.remove('on'));
  const el = document.getElementById(id);
  if (el) el.classList.add('on');
}

// ── OPPORTUNITIES ─────────────────────────────
const OPPS_PAGE_SIZE = 60; // matches the server default (ADR-0013); explicit so offset math is exact
function oppsFilterParams() {
  const q = val('opp-q'); const cat = val('f-cat');
  const commit = val('f-commit'); const date = val('f-date');
  const miles = val('f-miles') || '15';
  let params = new URLSearchParams();
  if (q) params.set('q',q);
  if (cat) params.set('category',cat);
  if (commit) params.set('commitment',commit);
  if (date) params.set('startDate',date);
  if (zipCoords) { params.set('zipLat',zipCoords.lat); params.set('zipLng',zipCoords.lng); params.set('maxMiles',miles); }
  return params;
}
async function loadOpps() {
  const grid = document.getElementById('opps-grid');
  grid.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    const format = val('f-format');
    const params = oppsFilterParams();
    params.set('limit', OPPS_PAGE_SIZE);
    const {data, headers} = await api('/api/opportunities?'+params, {raw:true});
    oppsRawCount = data.length;
    oppsTotal = Number(headers.get('x-total-count')) || data.length;
    allOpps = format ? data.filter(o=>(o.format||'In-Person')===format) : data;
    renderOpps(allOpps);
    renderLoadMoreBtn();
    updateDiscoverHash();
    renderFilterChips();
    loadRecommendations();
    loadSavedSearches();
  } catch(e) { grid.innerHTML=`<div class="loading" style="color:var(--red)">${esc(e.message)}</div>`; }
}
async function loadMoreOpps() {
  const btn = document.getElementById('opps-load-more-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const format = val('f-format');
    const params = oppsFilterParams();
    params.set('limit', OPPS_PAGE_SIZE);
    params.set('offset', oppsRawCount);
    const {data, headers} = await api('/api/opportunities?'+params, {raw:true});
    oppsRawCount += data.length;
    oppsTotal = Number(headers.get('x-total-count')) || oppsTotal;
    allOpps = allOpps.concat(format ? data.filter(o=>(o.format||'In-Person')===format) : data);
    renderOpps(allOpps);
  } catch(e) { toast(e.message,'err'); }
  renderLoadMoreBtn();
}
function renderLoadMoreBtn() {
  const wrap = document.getElementById('opps-load-more-wrap');
  if (!wrap) return;
  const remaining = oppsTotal - oppsRawCount;
  const count = oppsTotal>0 ? `<div style="font-size:.78rem;color:var(--muted);margin-bottom:${remaining>0?'10px':'0'}">Showing ${allOpps.length} of ${oppsTotal}</div>` : '';
  wrap.innerHTML = count + (remaining>0 ? `<button class="btn-s" id="opps-load-more-btn" data-action="loadMoreOpps">Load more (${remaining} more)</button>` : '');
}
// Mirror the active Discover filters into the hash (#discover?q=…&cat=…) so a
// filtered view survives refresh and can be shared. replaceState (not pushState)
// — typing in the search box must not spam history entries.
function updateDiscoverHash() {
  if (!document.getElementById('view-discover')?.classList.contains('active')) return;
  const qs = new URLSearchParams();
  const put = (k, v) => { if (v) qs.set(k, v); };
  put('q', val('opp-q')); put('cat', val('f-cat')); put('commit', val('f-commit'));
  put('format', val('f-format')); put('date', val('f-date'));
  put('zip', val('f-zip')); if (zipCoords) put('miles', val('f-miles'));
  const s = qs.toString();
  try { history.replaceState(null, '', '#discover' + (s ? '?' + s : '')); } catch { /* very old browsers */ }
}
// Restore filters from #discover?… (inverse of updateDiscoverHash), then load.
function restoreDiscoverFilters(hashQs) {
  const qp = new URLSearchParams(hashQs || '');
  const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  set('opp-q', qp.get('q')); set('f-cat', qp.get('cat')); set('f-commit', qp.get('commit'));
  set('f-format', qp.get('format')); set('f-date', qp.get('date'));
  set('f-miles', qp.get('miles')); set('f-zip', qp.get('zip'));
  if (qp.get('zip') && /^\d{5}$/.test(qp.get('zip'))) applyZip(); // geocodes, then calls loadOpps
  else loadOpps();
}
function debounce(){ clearTimeout(searchTimer); searchTimer=setTimeout(loadOpps,320); }

// ── ZIP FILTER ─────────────────────────────────
function onZipInput(){
  const z=val('f-zip');
  if(z.length===5&&/^\d{5}$/.test(z)) applyZip();
  else if(z.length<5){ zipCoords=null; setText('zip-status','Enter a 5-digit ZIP code.'); document.getElementById('zip-status').className='zip-status'; loadOpps(); }
}
function onMilesChange(){ if(zipCoords) loadOpps(); }

async function applyZip(){
  const z=val('f-zip');
  if(!/^\d{5}$/.test(z)){ setText('zip-status','Enter a valid 5-digit ZIP.'); document.getElementById('zip-status').className='zip-status err'; return; }
  const st=document.getElementById('zip-status');
  st.textContent='Looking up ZIP…'; st.className='zip-status';
  try {
    const geo=await api('/api/geocode?zip='+z);
    zipCoords=geo;
    st.textContent='📍 '+geo.city+', '+geo.state; st.className='zip-status ok';
    loadOpps();
  } catch(e){
    zipCoords=null; st.textContent=e.message; st.className='zip-status err';
  }
}

function clearZip(){ zipCoords=null; document.getElementById('f-zip').value=''; setText('zip-status','Searches default to 15 mi. Enter a ZIP or use your location to filter by distance.'); document.getElementById('zip-status').className='zip-status'; loadOpps(); }

// ── REAL-TIME GEOLOCATION ──────────────────────
// Uses the browser Geolocation API and feeds the same lat/lng distance pipeline
// as the ZIP filter. Coords are rounded to ~2 decimals (~1km) so precise GPS
// never lands in a request URL / server log — approximate distance is all we need.
function useMyLocation(){
  const st=document.getElementById('zip-status'), btn=document.getElementById('geo-btn');
  if(!navigator.geolocation){ st.textContent='Geolocation isn’t supported by this browser — enter a ZIP instead.'; st.className='zip-status err'; return; }
  if(!window.isSecureContext){ st.textContent='Location needs a secure (https) connection — enter a ZIP instead.'; st.className='zip-status err'; return; }
  if(btn) btn.disabled=true;
  st.textContent='Requesting your location…'; st.className='zip-status';
  navigator.geolocation.getCurrentPosition(
    pos=>{
      const lat=Math.round(pos.coords.latitude*100)/100, lng=Math.round(pos.coords.longitude*100)/100;
      zipCoords={lat,lng,city:'Your location',state:'',viaGeo:true};
      document.getElementById('f-zip').value='';
      st.textContent='📍 Using your approximate location'; st.className='zip-status ok';
      if(btn) btn.disabled=false;
      loadOpps();
    },
    err=>{
      if(btn) btn.disabled=false;
      st.textContent = err && err.code===1 ? 'Location permission denied — enter a ZIP instead.'
                    : err && err.code===2 ? 'Couldn’t determine your location — enter a ZIP instead.'
                    : err && err.code===3 ? 'Location request timed out — try again or enter a ZIP.'
                    : 'Location unavailable — enter a ZIP instead.';
      st.className='zip-status err';
    },
    { enableHighAccuracy:false, timeout:10000, maximumAge:300000 }
  );
}

// ── STORAGE NOTICE ─────────────────────────────
function maybeShowStorageNotice(){
  try{ if(localStorage.getItem('storageNoticeAck')) return; }catch{}
  const el=document.getElementById('cookie-notice'); if(el) el.hidden=false;
}
function ackStorageNotice(){
  try{ localStorage.setItem('storageNoticeAck','1'); }catch{}
  const el=document.getElementById('cookie-notice'); if(el) el.hidden=true;
}

// ── ACTIVE FILTER CHIPS ────────────────────────
function renderFilterChips(){
  const bar=document.getElementById('filter-bar'); if(!bar) return;
  const chips=[];
  const q=val('opp-q'), cat=val('f-cat'), commit=val('f-commit'), format=val('f-format'), date=val('f-date');
  const miles=val('f-miles')||'15';
  if(zipCoords) chips.push({cls:'fc-zip',label:(zipCoords.viaGeo?'📍 Near you':'📍 '+zipCoords.city+', '+zipCoords.state)+' ('+miles+' mi)',action:'clearZip'});
  if(q) chips.push({cls:'',label:'🔍 "'+esc(q)+'"',action:'clearFilter',arg:'opp-q'});
  if(cat) chips.push({cls:'fc-cat',label:'📂 '+cat,action:'clearFilter',arg:'f-cat'});
  if(commit) chips.push({cls:'fc-commit',label:'🔄 '+commit,action:'clearFilter',arg:'f-commit'});
  if(format) chips.push({cls:'fc-format',label:'📡 '+format,action:'clearFilter',arg:'f-format'});
  if(date) chips.push({cls:'fc-date',label:'📅 From '+date,action:'clearFilter',arg:'f-date'});
  if(!chips.length){ bar.innerHTML=''; return; }
  bar.innerHTML = chips.map(c=>`<span class="filter-chip ${c.cls}">${c.label}<button data-action="${c.action}"${c.arg?` data-args='["${c.arg}"]'`:''} title="Remove filter" aria-label="Remove filter">✕</button></span>`).join('')
    +`<button class="fc-clear" data-action="clearAllFilters">Clear all</button>`;
}
function clearAllFilters(){
  setval('opp-q',''); setval('f-cat',''); setval('f-commit',''); setval('f-format',''); setval('f-date',''); clearZip();
}
function setval(id,v){ const el=document.getElementById(id); if(el) el.value=v; }

function renderOpps(opps) {
  const grid = document.getElementById('opps-grid');
  if (!opps.length) { grid.innerHTML='<div class="empty"><div class="empty-icon">🔍</div>No opportunities found. Try adjusting your filters.</div>'; return; }
  opps = applySort(opps);
  grid.innerHTML = opps.map(o=>{
    const fmt_cls = ((o.format||'').toLowerCase()==='remote'||(o.location||'').toLowerCase().includes('remote'))?'format-remote':((o.format||'').toLowerCase()==='hybrid')?'format-hybrid':''; return `
    <div class="opp-card ${fmt_cls}${o.featured?' featured':''}" data-action="openOpp" data-args="${esc(JSON.stringify([o.id]))}">
      <div class="oc-top">
        <div class="oc-avatar" style="background:${o.bg||'#e8f5ef'}">${o.emoji||'🏛️'}</div>
        <div class="badges-row">
          ${o.featured?'<span class="badge badge-featured">★ Featured</span>':''}
          ${o.verified?'<span class="badge badge-verified">✓ Vetted</span>':''}
          ${(o.badges||[]).map(b=>{const L={verified:'',['top-rated']:'⭐ Top Rated',responsive:'⚡ Fast Response',established:'🏛 Established'};return b==='verified'?'':('<span class="badge org-badge ob-'+b+'">'+L[b]+'</span>');}).join('')}
        </div>
      </div>
      <div class="oc-title">${esc(o.title)}</div>
      <div class="oc-org" data-action="openOrgLanding" data-stop data-args="${esc(JSON.stringify([o.orgId]))}">${esc(o.orgName)}</div>
      <div class="oc-desc">${esc(o.description||'')}</div>
      <div class="badges-row" style="margin-bottom:8px">${(o.skills||[]).slice(0,3).map(s=>`<span class="badge badge-skill">${esc(s)}</span>`).join('')}</div>
      <div class="oc-meta">
        <span>📍 ${esc(o.location||'TBD')}</span>
        <span>⏱ ${fmt(o.durationHours)} hrs</span>
        <span>🔄 ${esc(o.commitment)}</span>
        <span>👥 ${o.spotsRemaining||0}/${o.spotsAvailable||0} spots</span>
        ${o.minAge?`<span>🔞 Age ${o.minAge}+</span>`:''}
      </div>
      <div style="margin-bottom:8px">
        ${(()=>{const loc=(o.location||'').toLowerCase();const f=o.format||'';const isRemote=loc.includes('remote')||f==='Remote';const isHybrid=f==='Hybrid'||loc.includes('hybrid');if(isRemote)return'<span class="format-pip remote">🌐 Remote</span>';if(isHybrid)return'<span class="format-pip hybrid">🔀 Hybrid</span>';return'<span class="format-pip inperson">📍 In-Person</span>';})()}
      </div>
      ${o.distanceMiles!=null?`<div class="dist-badge" style="margin-bottom:8px">📍 ${o.distanceMiles} mi away</div>`:''}
      <div class="oc-footer">
        <span style="font-size:.73rem;color:var(--muted)">${(()=>{const r=relDate(o.startTime);return (r==='Today'||r==='Tomorrow')?`<span style="color:var(--green);font-weight:700">${r}</span>`:r;})()}</span>
        <div style="display:flex;gap:6px">
          ${(!currentUser||currentUser.role==='student')?`<button class="icon-heart${currentUser?.savedOpps?.includes(o.id)?' on':''}" data-saveopp="${o.id}" title="Save for later" aria-label="Save opportunity for later" data-action="toggleSaveOpp" data-args="${esc(JSON.stringify([o.id]))}">${currentUser?.savedOpps?.includes(o.id)?'♥':'♡'}</button>`:''}
          <button class="btn-s" style="padding:7px 14px;font-size:.78rem" data-action="openOpp" data-stop data-args="${esc(JSON.stringify([o.id]))}">View & Apply</button>
        </div>
      </div>
    </div>`;}).join('');
}

async function openOpp(id) {
  currentOppId = id;
  api('/api/opportunities/'+id+'/view',{method:'POST'}).catch(()=>{}); // analytics beacon
  // Remember which page the user was on so we can return to it after signup/unsignup
  const activeView = document.querySelector('.view.active')?.id?.replace('view-','');
  if (activeView) oppOriginView = activeView;
  const o = allOpps.find(x=>x.id===id) || await api('/api/opportunities/'+id);
  document.getElementById('opp-m-title').textContent = o.title;
  document.getElementById('opp-m-org').textContent = o.orgName;
  document.getElementById('opp-m-org').dataset.orgid = o.orgId;

  const isRecurring = o.commitment === 'Weekly' || o.commitment === 'Monthly';
  const _today = new Date(); _today.setHours(0,0,0,0);
  const eventPast = !isRecurring && new Date(o.endTime||o.startTime) < _today;
  // Find all apps for this opp by current user
  const userApps = currentUser?.role==='student' ? (myApps||[]).filter(a=>a.oppId===id) : [];
  const subscription = userApps.find(a=>(a.type||'subscription')==='subscription');
  // Only future single-date signups count for display purposes (past ones are already logged as hours)
  const singleDates = userApps.filter(a=>a.type==='single-date' && (!a.singleDate || new Date(a.singleDate) >= _today));
  const alreadyApplied = subscription || singleDates[0] || null;
  const waitlistApp = userApps.find(a=>a.status==='waitlisted');
  const isFull = (o.spotsRemaining||0)===0;
  const canApply = currentUser?.role==='student' && !subscription && !isFull && !eventPast;

  // Generate upcoming occurrences for recurring events
  let upcomingDatesHtml = '';
  if (isRecurring && currentUser?.role==='student') {
    const dates = _getUpcomingOccurrences(o, 8);
    const excludedSet = new Set((subscription?.excludedDates||[]).map(d=>d.slice(0,10)));
    const singleSet = new Set(singleDates.map(a=>a.singleDate?.slice(0,10)));
    const dateSpotsMap = await api('/api/opportunities/'+id+'/date-spots').catch(()=>({}));
    upcomingDatesHtml = `
      <div id="upcoming-dates-section" style="margin-top:16px">
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px">
          ${subscription ? 'Your Subscribed Dates' : (singleDates.length ? 'Upcoming Dates — pick more to add' : 'Or sign up for a single day:')}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;max-height:240px;overflow-y:auto">
          ${dates.map(d=>{
            const ds = d.toISOString().slice(0,10);
            const label = d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
            const timeLabel = new Date(o.startTime).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
            if (subscription) {
              const isExcluded = excludedSet.has(ds);
              return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:${isExcluded?'#f9fafb':'var(--green-pale)'};border:1px solid ${isExcluded?'var(--border)':'var(--green-mid)'};border-radius:8px;font-size:.82rem">
                <span style="${isExcluded?'text-decoration:line-through;opacity:.5':''}">📅 ${label} at ${timeLabel}</span>
                ${isExcluded
                  ?`<button class="btn-s" style="padding:3px 10px;font-size:.7rem" data-action="reincludeDate" data-args="${esc(JSON.stringify([o.id, ds]))}">Rejoin</button>`
                  :`<button class="btn-s" style="padding:3px 10px;font-size:.7rem;color:var(--red);border-color:var(--red)" data-action="excludeDate" data-args="${esc(JSON.stringify([o.id, ds, o.title]))}">Skip this date</button>`}
              </div>`;
            } else {
              const isSignedUp = singleSet.has(ds);
              const dateSpots = dateSpotsMap[ds] ?? o.spotsAvailable;
              const dateFull = dateSpots === 0;
              return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:${isSignedUp?'var(--green-pale)':'#f9fafb'};border:1px solid ${isSignedUp?'var(--green-mid)':'var(--border)'};border-radius:8px;font-size:.82rem">
                <span style="display:flex;align-items:center;gap:8px">
                  <span>📅 ${label} at ${timeLabel}</span>
                  ${!isSignedUp?`<span style="font-size:.68rem;color:${dateFull?'var(--red)':'var(--muted)'};font-weight:600">${dateFull?'Full':''+dateSpots+' spot'+(dateSpots===1?'':'s')+' available'}</span>`:''}
                </span>
                ${isSignedUp
                  ?`<button class="btn-s" style="padding:3px 10px;font-size:.7rem;color:var(--red);border-color:var(--red)" data-action="unsignSingleDate" data-args="${esc(JSON.stringify([o.id, o.title, ds]))}">Unsign up for this day</button>`
                  :(dateFull?'<span style="font-size:.72rem;color:var(--red);font-weight:600">Full</span>':`<button class="btn-s" style="padding:3px 10px;font-size:.7rem" data-action="applyToOpp" data-args="${esc(JSON.stringify([o.id, o.title, o.requiresApproval, 'single-date', ds]))}">Sign up for this day</button>`)}
              </div>`;
            }
          }).join('')}
        </div>
      </div>`;
  }

  document.getElementById('opp-m-body').innerHTML = `
    <div class="badges-row" style="margin-bottom:14px">
      ${o.verified?'<span class="badge badge-verified">✓ Vetted Organization</span>':''}
      <span class="badge badge-verified">Open to All</span>
    </div>
    <div style="margin-bottom:12px">
      ${(()=>{const loc=(o.location||'').toLowerCase();const f=o.format||'';const isRemote=loc.includes('remote')||f==='Remote';const isHybrid=f==='Hybrid'||loc.includes('hybrid');if(isRemote)return'<span class="format-pip remote" style="font-size:.8rem;padding:4px 12px">🌐 Remote</span>';if(isHybrid)return'<span class="format-pip hybrid" style="font-size:.8rem;padding:4px 12px">🔀 Hybrid</span>';return'<span class="format-pip inperson" style="font-size:.8rem;padding:4px 12px">📍 In-Person</span>';})()}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;font-size:.84rem">
      <div>📍 <strong>Location:</strong> ${esc(o.location)}</div>
      <div>📅 <strong>Start:</strong> ${fmtDateTime(o.startTime)}</div>
      <div>⏰ <strong>End:</strong> ${fmtDateTime(o.endTime)}</div>
      <div>⏱ <strong>Duration:</strong> ${fmt(o.durationHours)} hours</div>
      <div>🔄 <strong>Commitment:</strong> ${esc(o.commitment)}</div>
      ${!isRecurring?`<div>👥 <strong>Spots:</strong> ${o.spotsRemaining}/${o.spotsAvailable} remaining</div>`:''}
    </div>
    <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px">Description</div>
    <p style="font-size:.88rem;line-height:1.7;font-weight:300;color:var(--text);margin-bottom:16px">${esc(o.description)}</p>
    ${o.skills?.length?`<div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:8px">Skills Needed</div><div class="badges-row" style="margin-bottom:16px">${o.skills.map(s=>`<span class="badge badge-skill">${esc(s)}</span>`).join('')}</div>`:''}
    <div id="apply-conflict-warn" class="conflict-warn"></div>
    ${(()=>{ if(o.minAge&&currentUser?.role==='student'&&currentUser.dob){ const age=(Date.now()-new Date(currentUser.dob))/(365.25*864e5); if(age<o.minAge) return `<div class="disclaimer-box">⚠️ <strong>Age requirement:</strong> this opportunity asks for volunteers age ${o.minAge}+. You can still apply, but the organization may not be able to accept you.</div>`; } return ''; })()}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;margin-bottom:8px">
      ${canApply && !isRecurring?`<button class="btn-p" id="apply-btn" data-action="applyToOpp" data-args="${esc(JSON.stringify([o.id, o.title, o.requiresApproval]))}">${o.requiresApproval?'Request to Join':'Sign Up'}</button>`:''}
      ${canApply && isRecurring?`
        <div style="background:var(--green-pale);border:1px solid var(--green-mid);border-radius:12px;padding:14px 16px;width:100%">
          <div style="font-size:.75rem;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">How would you like to sign up?</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn-p" id="apply-btn" data-action="applyToOpp" data-args="${esc(JSON.stringify([o.id, o.title, o.requiresApproval, 'subscription']))}" style="flex:1;min-width:180px">🔄 Subscribe — Every ${esc(o.commitment)} Date</button>
            <button class="btn-s" style="padding:10px 16px;font-size:.85rem;flex:1;min-width:160px" data-action="scrollToDates">📅 Just One Day ↓</button>
          </div>
        </div>`:''}
      ${isRecurring && subscription?`
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div style="background:var(--green-pale);color:var(--green);padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:600">🔄 ${subscription.status==='pending'?'Subscription Pending':'Subscribed to all dates'}</div>
          ${subscription.status==='approved'?`<button class="btn-s" id="unsub-btn" style="padding:10px 18px;font-size:.85rem;color:var(--red);border-color:var(--red)" data-action="unsubscribeOpp" data-args="${esc(JSON.stringify([o.id, o.title]))}">Unsubscribe from all dates</button>`:''}
        </div>`:''}
      ${isRecurring && !subscription && singleDates.length?`<div style="background:var(--green-pale);color:var(--green);padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:600">📅 Signed up for ${singleDates.length} date${singleDates.length>1?'s':''} — see below to add/remove</div>`:''}
      ${!isRecurring && alreadyApplied?`
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div style="background:var(--green-pale);color:var(--green);padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:600">${eventPast?'✅ Attended':'✓ '+( alreadyApplied.status==='pending'?'Application Pending':'You\'re Signed Up')}</div>
          ${alreadyApplied.status==='approved'&&!eventPast?`<button class="btn-s" id="unsub-btn" style="padding:10px 18px;font-size:.85rem;color:var(--red);border-color:var(--red)" data-action="unsubscribeOpp" data-args="${esc(JSON.stringify([o.id, o.title]))}">Unsign up</button>`:''}
        </div>`:''}
      ${waitlistApp?`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <div style="background:#ede9fe;color:#5b21b6;padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:600">🕐 On the waitlist — you'll be auto-signed up if a spot opens</div>
        <button class="btn-s" style="padding:10px 18px;font-size:.85rem;color:var(--red);border-color:var(--red)" data-action="leaveWaitlist" data-args="${esc(JSON.stringify([o.id]))}">Leave waitlist</button>
      </div>`:''}
      ${isFull&&!alreadyApplied&&!waitlistApp?(
        (!isRecurring&&currentUser?.role==='student'&&!eventPast)
          ?`<button class="btn-p" data-action="joinWaitlist" data-args="${esc(JSON.stringify([o.id, o.title]))}">🕐 Join Waitlist</button>`
          :`<div style="background:#f3f4f6;color:var(--muted);padding:10px 18px;border-radius:10px;font-size:.85rem;font-weight:600">No spots remaining</div>`
      ):''}
      ${currentUser?.role==='student'&&(subscription||alreadyApplied)?.status==='approved'?`<button class="btn-s" style="padding:10px 18px;font-size:.85rem" data-action="openChat" data-args="${esc(JSON.stringify([o.id, o.title]))}">💬 Messages</button>`:''}
      <button class="btn-s" style="padding:10px 14px;font-size:.85rem" data-action="copyOppLink" data-args="${esc(JSON.stringify([o.id]))}">🔗 Share</button>
      ${(!currentUser||currentUser.role==='student')?`<button class="btn-s" style="padding:10px 14px;font-size:.85rem" data-saveopp="${o.id}" data-action="toggleSaveOpp" data-args="${esc(JSON.stringify([o.id]))}">${currentUser?.savedOpps?.includes(o.id)?'♥ Saved':'♡ Save'}</button>`:''}
      ${!currentUser?`<button class="btn-p" data-action="loginToApply">Log in to Apply</button>`:''}
    </div>
    ${upcomingDatesHtml}`;
  openM('opp-overlay');
}

function _getUpcomingOccurrences(opp, count) {
  const commit = opp.commitment || 'One-time';
  if (commit === 'One-time') return [new Date(opp.startTime)];
  const results = [];
  let cur = new Date(opp.startTime);
  const now = new Date();
  // Find first occurrence on or after today
  for (let i = 0; i < 500 && cur < now; i++) {
    if (commit === 'Weekly') cur.setDate(cur.getDate() + 7);
    else cur.setMonth(cur.getMonth() + 1);
  }
  for (let i = 0; i < count && results.length < count; i++) {
    results.push(new Date(cur));
    if (commit === 'Weekly') cur.setDate(cur.getDate() + 7);
    else cur.setMonth(cur.getMonth() + 1);
  }
  return results;
}

function returnToOriginView() {
  if (!currentUser || currentUser.role !== 'student') return;
  if (oppOriginView === 'discover') { nav('discover'); loadOpps(); }
  else if (oppOriginView === 'org-landing') { nav('discover'); loadOpps(); }
  else loadStudentDash();
}

async function applyToOpp(id, title, requiresApproval, signupType, singleDate) {
  if (!currentUser) { openAuth('login'); return; }
  signupType = signupType || 'subscription';
  singleDate = singleDate || null;
  try {
    const btn = document.getElementById('apply-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
    const res = await api('/api/opportunities/'+id+'/apply', {method:'POST', body:JSON.stringify({signupType, singleDate})});
    if (res.conflicts?.length) {
      const warn = document.getElementById('apply-conflict-warn');
      if (warn) { warn.style.display='block'; warn.innerHTML = `⚠️ <strong>Schedule conflict!</strong> This overlaps with: ${res.conflicts.map(c=>`<em>${esc(c.title)}</em> (${fmtDate(c.startTime)})`).join(', ')}. You've been signed up anyway — please review your calendar.`; }
    }
    await loadMyApps();
    if (signupType === 'single-date') {
      const dateLabel = new Date(singleDate).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      toast(`Signed up for "${title}" on ${dateLabel}! 🎉`);
      openOpp(id); // Re-render modal to update date list
      if (currentUser.role==='student') { renderCal('cal-root'); renderUpcoming(); }
    } else {
      closeM('opp-overlay');
      toast(requiresApproval ? 'Application submitted! The org will review it.' : `Subscribed to "${title}"! 🎉`);
      returnToOriginView();
    }
    syncCalendarNow();
  } catch(e) {
    const btn = document.getElementById('apply-btn');
    if (btn) { btn.disabled=false; btn.textContent = requiresApproval?'Request to Join':'Sign Up'; }
    if (e.code==='GUARDIAN_CONSENT_REQUIRED') {
      toast(`Ask ${currentUser.guardianName||'your parent/guardian'} to check their email and approve your account first.`,'err');
    } else {
      toast(e.message,'err');
    }
  }
}

// ── STUDENT DASHBOARD ─────────────────────────
async function loadStudentDash() {
  if (!currentUser||currentUser.role!=='student') return;
  nav('dash');
  const u = currentUser;
  setText('ds-avatar',(u.firstName||'U').charAt(0).toUpperCase());
  setText('ds-name',`${u.firstName} ${u.lastName}`);
  setText('ds-role',`Student${u.grade?' · '+u.grade:''}`);
  document.getElementById('pf-school').value = u.school||'';
  document.getElementById('pf-location').value = u.location||'';
  if (u.grade) document.getElementById('pf-grade').value = u.grade;
  document.getElementById('pf-email-notifs').checked = u.emailNotifications!==false;
  renderMfaSection('mfa-section-student');

  await api('/api/hours/auto-log-attended',{method:'POST'}).catch(()=>{});
  await loadMyHours();
  await loadMyApps();
  renderCal('cal-root');
  renderUpcoming();
  updateCalToggleUI();
  updateCalFeedInfo();
  await loadAwards();
  populateLogOpps();
  loadEndorsements(currentUser.id);
  renderGoal();
  renderOnboarding();
  // Set portfolio checkbox
  const pfPub = document.getElementById('pf-portfolio-public');
  if (pfPub) pfPub.checked = !!currentUser.portfolioPublic;
}

async function unsubscribeOpp(id, title) {
  const unsubOk = await _showDialog({icon:'📅', title:`Unsubscribe from "${title}"?`, msg:'This will remove you from all future occurrences of this event.', confirmText:'Unsubscribe', danger:true});
  if (!unsubOk) return;
  try {
    const btn = document.getElementById('unsub-btn');
    if (btn) { btn.disabled=true; btn.textContent='Removing…'; }
    await api('/api/opportunities/'+id+'/unsubscribe', {method:'DELETE', body:JSON.stringify({})});
    await loadMyApps();
    closeM('opp-overlay');
    toast(`Unsubscribed from "${title}".`);
    returnToOriginView();
    syncCalendarNow();
  } catch(e) {
    toast(e.message, 'err');
    const btn = document.getElementById('unsub-btn');
    if (btn) { btn.disabled=false; btn.textContent='Unsubscribe'; }
  }
}
async function excludeDate(oppId, dateStr, title) {
  const label = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const ok = await _showDialog({icon:'📅', title:`Skip ${label}?`, msg:`You'll still be subscribed to other "${title}" dates.`, confirmText:'Skip This Date', danger:true});
  if (!ok) return;
  try {
    await api('/api/opportunities/'+oppId+'/exclude-date', {method:'PATCH', body:JSON.stringify({date:dateStr, action:'exclude'})});
    await loadMyApps();
    toast(`Skipping ${label}`);
    openOpp(oppId);
    if (currentUser.role==='student') { renderCal('cal-root'); renderUpcoming(); }
    syncCalendarNow();
  } catch(e) { toast(e.message,'err'); }
}
async function reincludeDate(oppId, dateStr) {
  try {
    await api('/api/opportunities/'+oppId+'/exclude-date', {method:'PATCH', body:JSON.stringify({date:dateStr, action:'include'})});
    await loadMyApps();
    const label = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    toast(`Re-joined ${label}`);
    openOpp(oppId);
    if (currentUser.role==='student') { renderCal('cal-root'); renderUpcoming(); }
    syncCalendarNow();
  } catch(e) { toast(e.message,'err'); }
}
async function unsignSingleDate(oppId, title, dateStr) {
  const label = new Date(dateStr+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  const ok = await _showDialog({icon:'📅', title:`Unsign up for ${label}?`, msg:`Remove your signup for "${title}" on this date.`, confirmText:'Unsign up', danger:true});
  if (!ok) return;
  try {
    await api('/api/opportunities/'+oppId+'/unsubscribe', {method:'DELETE', body:JSON.stringify({singleDate:dateStr})});
    await loadMyApps();
    toast(`Removed signup for ${label}`);
    openOpp(oppId);
    if (currentUser.role==='student') { renderCal('cal-root'); renderUpcoming(); }
    syncCalendarNow();
  } catch(e) { toast(e.message,'err'); }
}

async function loadMyHours() {
  try {
    myHours = await api('/api/hours');
    renderHoursTable();
    const verified = myHours.filter(h=>h.status==='verified').reduce((s,h)=>s+h.hours,0);
    const pending = myHours.filter(h=>['pending','self'].includes(h.status)).reduce((s,h)=>s+h.hours,0);
    const total = myHours.reduce((s,h)=>s+h.hours,0);
    setText('ds-verified', fmt(verified));
    setText('ds-pending', fmt(pending));
    setText('ds-total', fmt(total));
    renderGoal();
  } catch {}
}

async function loadMyApps() {
  try { myApps = await api('/api/applications/my'); } catch {}
}

function renderHoursTable() {
  const tbody = document.getElementById('hours-tbody');
  const filtered = hoursFilter==='all' ? myHours : myHours.filter(h=>h.status===hoursFilter);
  if (!filtered.length) { tbody.innerHTML=`<tr><td colspan="6" class="empty">No hours in this category yet.</td></tr>`; return; }
  tbody.innerHTML = filtered.map(h=>{
    const labels = {verified:'Verified',pending:'Pending Verification',self:'Self-Reported',denied:'Denied'};
    const cls = {verified:'sp-verified',pending:'sp-pending',self:'sp-self',denied:'sp-denied'};
    return `<tr>
      <td><strong style="color:var(--dark)">${esc(h.orgName)}</strong><br><span style="font-size:.75rem;color:var(--muted)">${esc(h.activity)}</span></td>
      <td>${fmtDate(h.startTime)}</td>
      <td><strong>${fmt(h.hours)}</strong></td>
      <td><span class="status-pill ${cls[h.status]||'sp-pending'}">${labels[h.status]||h.status}</span>${h.status==='denied'&&h.appeal!=='used'?`<button data-action="openAppeal" data-args="${esc(JSON.stringify([h.id]))}" style="margin-left:6px;font-size:.7rem;color:var(--blue);background:none;border:none;cursor:pointer;text-decoration:underline">Appeal</button>`:''}</td>
      <td style="font-size:.78rem;color:var(--muted)">${esc(h.supervisorName||'—')}</td>
      <td>${h.status!=='verified'?`<button data-action="delHour" data-args="${esc(JSON.stringify([h.id]))}" aria-label="Delete this hours entry" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:.75rem;padding:3px 7px;border-radius:6px" data-mouseover="colorRed" data-mouseout="colorMuted">✕</button>`:''}</td>
    </tr>`;
  }).join('');
}

function filterHours(type, btn) {
  document.querySelectorAll('#dpanel-history .tab').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');
  hoursFilter=type; renderHoursTable();
}

async function delHour(id) {
  const delOk = await _showDialog({icon:'🗑️', title:'Remove this entry?', msg:'This hours entry will be permanently deleted.', confirmText:'Remove', danger:true});
  if (!delOk) return;
  try { await api('/api/hours/'+id,{method:'DELETE'}); await loadMyHours(); toast('Removed'); } catch(e){ toast(e.message,'err'); }
}

async function openAppeal(id) {
  const note = await _showDialog({icon:'📝', title:'Appeal Hours Decision', msg:'Briefly explain why these hours should be re-reviewed:', confirmText:'Submit Appeal', hasInput:true, inputPlaceholder:'Your explanation…'});
  if (!note) return;
  try { await api('/api/hours/'+id+'/appeal',{method:'PATCH',body:JSON.stringify({note})}); await loadMyHours(); toast('Appeal submitted!'); } catch(e){ toast(e.message,'err'); }
}

// ── LOG HOURS ─────────────────────────────────
function populateLogOpps() {
  const sel = document.getElementById('log-opp-sel');
  if (!sel) return;
  sel.innerHTML = allOpps.length ? allOpps.map(o=>`<option value="${o.id}">${esc(o.title)} — ${esc(o.orgName)}</option>`).join('') : '<option value="">No opportunities loaded — load from Discover first</option>';
}
function toggleLogType() {}


// ── DATE-TIME PICKER HELPERS ─────────────────────────────
function initDTPicker(id) {
  // Leave hr/mn empty so placeholders show; just clear values
  const hrEl = document.getElementById(id+'-hr');
  const mnEl = document.getElementById(id+'-mn');
  if (hrEl) hrEl.value = '';
  if (mnEl) mnEl.value = '';
}

// Clamp hour input 1–12 while typing
function clampHr(el) {
  let v = parseInt(el.value,10);
  if (isNaN(v)) return;
  if (v > 12) el.value = 12;
  if (v < 1)  el.value = 1;
}

// Clamp minutes 0–59 while typing
function clampMin(el) {
  let v = parseInt(el.value,10);
  if (isNaN(v)) return;
  if (v > 59) el.value = 59;
  if (v < 0)  el.value = 0;
}

// Zero-pad and clamp on blur — only if user actually typed something
function padNum(el, min, max) {
  if (el.value === '' || el.value === null) return;
  let v = parseInt(el.value,10);
  if (isNaN(v)) { el.value = ''; return; }
  v = Math.max(min, Math.min(max, v));
  // Only zero-pad minutes (min===0), not hours
  el.value = min === 0 ? String(v).padStart(2,'0') : String(v);
}

function updateDT(id) {
  const dateEl = document.getElementById(id+'-date');
  const hrEl   = document.getElementById(id+'-hr');
  const mnEl   = document.getElementById(id+'-mn');
  const apEl   = document.getElementById(id+'-ap');
  const hidden = document.getElementById(id);
  if (!dateEl||!hrEl||!mnEl||!apEl||!hidden) return;
  if (!dateEl.value) { hidden.value=''; return; }
  let h = parseInt(hrEl.value,10) || 12;
  const mn = mnEl.value || '00';
  const ap = apEl.value;
  if (ap==='AM' && h===12) h=0;
  if (ap==='PM' && h!==12) h+=12;
  hidden.value = dateEl.value+'T'+String(h).padStart(2,'0')+':'+mn;
}

function setDT(id, isoStr) {
  if (!isoStr) return;
  const dt = new Date(isoStr);
  const dateEl = document.getElementById(id+'-date');
  const hrEl   = document.getElementById(id+'-hr');
  const mnEl   = document.getElementById(id+'-mn');
  const apEl   = document.getElementById(id+'-ap');
  const hidden = document.getElementById(id);
  if (!dateEl) return;
  const yr = dt.getFullYear();
  const mo = String(dt.getMonth()+1).padStart(2,'0');
  const dy = String(dt.getDate()).padStart(2,'0');
  dateEl.value = yr+'-'+mo+'-'+dy;
  let h24 = dt.getHours();
  let m = Math.round(dt.getMinutes()/15)*15;
  if (m===60) { m=0; h24=(h24+1)%24; }
  const ap = h24<12 ? 'AM' : 'PM';
  const h12 = h24%12 || 12;
  const mnStr = String(m).padStart(2,'0');
  if (hrEl) hrEl.value = String(h12);
  if (mnEl) mnEl.value = mnStr;
  if (apEl) apEl.value = ap;
  if (hidden) hidden.value = dateEl.value+'T'+String(h24).padStart(2,'0')+':'+mnStr;
}

function updateLogDur() {
  const sv = document.getElementById('log-start').value;
  const ev = document.getElementById('log-end').value;
  if (!sv||!ev) { show('log-duration',false); return; }
  const diff = (new Date(ev)-new Date(sv))/36e5;
  if (diff>0) { setText('log-dur-val',fmt(diff)); show('log-duration',true); }
  else show('log-duration',false);
}

function updatePostDur() {
  const sv = document.getElementById('p-start').value;
  const ev = document.getElementById('p-end').value;
  if (!sv||!ev) { show('p-duration',false); return; }
  const diff = (new Date(ev)-new Date(sv))/36e5;
  if (diff>0) { setText('p-dur-val',fmt(diff)); show('p-duration',true); }
  else show('p-duration',false);
}

document.addEventListener('DOMContentLoaded', () => {
  ['log-start','log-end','p-start','p-end'].forEach(id => initDTPicker(id));
});

async function submitLogHours() {
  const start = val('log-start'); const end = val('log-end');
  const err = document.getElementById('log-err');
  err.style.display='none';
  if (!start||!end) { err.textContent='Start and end time are required.'; err.style.display='block'; return; }
  const hrs = (new Date(end)-new Date(start))/36e5;
  if (hrs<=0) { err.textContent='End time must be after start time.'; err.style.display='block'; return; }
  const orgName = val('log-org-name'); const activity = val('log-activity');
  if (!orgName||!activity) { err.textContent='Organization name and activity are required.'; err.style.display='block'; return; }
  const payload = {type:'self', startTime:start, endTime:end, notes:val('log-notes'), orgName, activity};
  try {
    document.getElementById('log-btn').disabled=true;
    await api('/api/hours',{method:'POST',body:JSON.stringify(payload)});
    await loadMyHours();
    toast('Hours logged!');
    document.getElementById('log-btn').disabled=false;
    switchDash('history',document.getElementById('dtab-history'));
  } catch(e) { err.textContent=e.message; err.style.display='block'; document.getElementById('log-btn').disabled=false; }
}

// ── CALENDAR ──────────────────────────────────

// ── RECURRING EVENT EXPANSION ─────────────────────────────────────────
// Takes a list of opp/app objects and expands weekly/monthly ones into
// individual occurrence objects for the given year+month view.
// Returns a flat array where each item has a .displayDate (JS Date) added.
function expandRecurring(events, year, month) {
  const results = [];
  const viewStart = new Date(year, month, 1);
  const viewEnd   = new Date(year, month + 1, 0, 23, 59, 59);

  events.forEach(e => {
    const opp = e.opp || e; // works for both app objects and raw opps
    if (!opp?.startTime) return;

    const appType = e.type || 'subscription';
    const excludedSet = new Set((e.excludedDates||[]).map(d=>d.slice(0,10)));

    // Single-date app: only show on that one date
    if (appType === 'single-date' && e.singleDate) {
      const sd = new Date(e.singleDate);
      if (sd >= viewStart && sd <= viewEnd) {
        const origin = new Date(opp.startTime);
        const durMs = opp.endTime ? (new Date(opp.endTime) - origin) : 0;
        const timeOfDay = e.singleDate.slice(0,10)+'T'+opp.startTime.split('T')[1];
        const occStart = new Date(timeOfDay);
        const occEnd = durMs ? new Date(occStart.getTime() + durMs) : null;
        results.push({
          ...e,
          displayDate: sd,
          ...(e.opp ? {opp: {...opp, startTime: occStart.toISOString(), endTime: occEnd?.toISOString()}} : {startTime: occStart.toISOString(), endTime: occEnd?.toISOString()})
        });
      }
      return;
    }

    const origin  = new Date(opp.startTime);
    const commit  = opp.commitment || 'One-time';
    const durMs   = opp.endTime ? (new Date(opp.endTime) - origin) : 0;

    if (commit === 'One-time') {
      if (origin >= viewStart && origin <= viewEnd) results.push({...e, displayDate: origin});
      return;
    }

    // Generate occurrences, skipping excluded dates
    const windowStart = new Date(viewStart); windowStart.setFullYear(windowStart.getFullYear() - 2);
    const windowEnd   = new Date(viewEnd);   windowEnd.setFullYear(windowEnd.getFullYear()   + 2);

    let cur = new Date(origin);
    let safety = 0;
    while (cur <= windowEnd && safety++ < 500) {
      if (cur >= viewStart && cur <= viewEnd && !excludedSet.has(cur.toISOString().slice(0,10))) {
        const occEnd = durMs ? new Date(cur.getTime() + durMs) : null;
        results.push({
          ...e,
          displayDate: new Date(cur),
          ...(e.opp ? {opp: {...opp, startTime: cur.toISOString(), endTime: occEnd?.toISOString()}} : {startTime: cur.toISOString(), endTime: occEnd?.toISOString()})
        });
      }
      if (commit === 'Weekly') {
        cur = new Date(cur); cur.setDate(cur.getDate() + 7);
      } else if (commit === 'Monthly') {
        cur = new Date(cur); cur.setMonth(cur.getMonth() + 1);
      } else break;
    }
  });

  return results;
}

// Next occurrence of a recurring event on or after a given date
function nextOccurrence(opp, afterDate, excludedDates) {
  if (!opp?.startTime) return null;
  const origin = new Date(opp.startTime);
  const commit = opp.commitment || 'One-time';
  const excluded = new Set((excludedDates||[]).map(d=>d.slice(0,10)));
  if (commit === 'One-time') return new Date(opp.startTime) >= afterDate ? new Date(opp.startTime) : null;
  let cur = new Date(origin);
  let safety = 0;
  while (safety++ < 500) {
    if (cur >= afterDate && !excluded.has(cur.toISOString().slice(0,10))) return cur;
    if (commit === 'Weekly')  cur.setDate(cur.getDate() + 7);
    else if (commit === 'Monthly') cur.setMonth(cur.getMonth() + 1);
    else break;
  }
  return null;
}

function renderCal(rootId, oppSource) {
  const root = document.getElementById(rootId);
  if (!root) return;
  const eventsSource = oppSource || myApps.filter(a=>a.status==='approved' && a.opp);
  const firstDay = new Date(calYear,calMonth,1).getDay();
  const daysInMonth = new Date(calYear,calMonth+1,0).getDate();
  const today = new Date();
  const monthName = new Date(calYear,calMonth).toLocaleString('default',{month:'long'});
  let html = `<div class="cal-wrap">
    <div class="cal-hdr">
      <span class="cal-title">${monthName} ${calYear}</span>
      <div class="cal-nav">
        <button class="cal-btn" data-action="calNav" data-args="${esc(JSON.stringify([-1, rootId, !!oppSource]))}" aria-label="Previous month">‹</button>
        <button class="cal-btn" data-action="calNav" data-args="${esc(JSON.stringify([1, rootId, !!oppSource]))}" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-day-head">${d}</div>`).join('')}`;
  const expanded = expandRecurring(eventsSource, calYear, calMonth);
  const eventsByDay = {};
  expanded.forEach(e => {
    const ed = e.displayDate || new Date(e.startTime);
    const d = ed.getDate();
    if (!eventsByDay[d]) eventsByDay[d] = [];
    eventsByDay[d].push(e);
  });
  let day=1; const totalCells = Math.ceil((firstDay+daysInMonth)/7)*7;
  for (let i=0;i<totalCells;i++) {
    const isOther = i<firstDay||(day>daysInMonth);
    const d = isOther ? null : day;
    const isToday = d&&new Date(calYear,calMonth,d).toDateString()===today.toDateString();
    const dayEvents = d ? (eventsByDay[d] || []) : [];
    html += `<div class="cal-day${isOther?' other-month':''}${isToday?' today':''}">
      <div class="cal-date">${d||''}</div>
      ${dayEvents.map(e=>{
        const opp=e.opp||e;
        const fmt=(opp.format||'').toLowerCase();
        const loc=(opp.location||'').toLowerCase();
        const fmtCls=fmt==='remote'||loc.includes('remote')?'remote':fmt==='hybrid'?'hybrid':'';
        return `<div class="cal-event ${fmtCls}" data-action="openOpp" data-args="${esc(JSON.stringify([e.oppId||e.id]))}" title="${esc(e.title||e.oppTitle||opp.title)}">${esc((e.title||e.oppTitle||opp.title||'').substring(0,18))}</div>`;
      }).join('')}
    </div>`;
    if (d) day++;
  }
  html += `</div></div>`;
  root.innerHTML = html;
}

function calNav(dir, rootId, isOrg) {
  calMonth+=dir;
  if (calMonth<0){calMonth=11;calYear--;} if(calMonth>11){calMonth=0;calYear++;}
  if (isOrg) {
    const orgOpps = currentUser ? allOpps.filter(o=>o.orgId===currentUser.orgId) : [];
    renderCal(rootId, orgOpps);
  } else renderCal(rootId);
}

function renderUpcoming() {
  const list = document.getElementById('upcoming-list');
  if (!list) return;
  const now = new Date();
  const upcoming = myApps
    .filter(a => a.status==='approved' && a.opp)
    .map(a => {
      const appType = a.type || 'subscription';
      if (appType === 'single-date' && a.singleDate) {
        const sd = new Date(a.singleDate);
        return sd >= now ? {...a, _nextDate: sd, opp: {...a.opp, startTime: sd.toISOString()}} : null;
      }
      const next = nextOccurrence(a.opp, now, a.excludedDates);
      return next ? {...a, _nextDate: next, opp: {...a.opp, startTime: next.toISOString()}} : null;
    })
    .filter(Boolean)
    .sort((a,b) => a._nextDate - b._nextDate)
    .slice(0,5);
  if (!upcoming.length) { list.innerHTML='<div class="empty" style="padding:16px">No upcoming events. <span style="color:var(--green);cursor:pointer" data-action="goDiscover">Find opportunities →</span></div>'; return; }
  list.innerHTML = upcoming.map(a=>`
    <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;gap:14px;align-items:center;cursor:pointer;transition:.15s"
         data-mouseover="upcomingHoverOn"
         data-mouseout="upcomingHoverOff"
         data-action="openOpp" data-args="${esc(JSON.stringify([a.oppId]))}">
      <div style="flex:1;pointer-events:none">
        <div style="font-weight:600;font-size:.9rem;color:var(--dark)">${esc(a.oppTitle)}</div>
        <div style="font-size:.78rem;color:var(--muted)">${esc(a.orgName)} · ${fmtDateTime(a.opp.startTime)}</div>
        <div style="font-size:.72rem;color:var(--green);margin-top:3px;font-weight:600">Click to view details →</div>
      </div>
      <button class="btn-s" style="padding:6px 14px;font-size:.78rem;flex-shrink:0" data-action="openChat" data-stop data-args="${esc(JSON.stringify([a.oppId, a.oppTitle]))}">💬</button>
    </div>`).join('');
}

// ── AWARDS ────────────────────────────────────
async function loadAwards() {
  try {
    const awards = await api('/api/awards');
    const list = document.getElementById('awards-list');
    list.innerHTML = awards.map(a=>`
      <div class="award-card">
        <div class="award-icon ${a.achieved?'award-achieved':'award-locked'}">${a.achieved?'🏆':'🔒'}</div>
        <div class="award-info">
          <div class="award-name">${esc(a.name)}</div>
          <div class="award-desc">${esc(a.description)}</div>
          <div style="position:relative;height:8px;background:var(--border);border-radius:100px;overflow:hidden;margin-bottom:5px">
            ${!a.achieved&&a.allHours>a.verifiedHours?`<div style="position:absolute;left:0;top:0;bottom:0;width:${a.allProgress}%;background:rgba(26,107,74,.22);border-radius:100px;transition:width .6s var(--ease)"></div>`:''}
            <div style="position:absolute;left:0;top:0;bottom:0;width:${a.progress}%;background:${a.achieved?'linear-gradient(90deg,#f59e0b,#fbbf24)':'linear-gradient(90deg,var(--green),var(--green-l))'};border-radius:100px;transition:width .6s var(--ease)"></div>
          </div>
          <div class="progress-label">${a.achieved?'✅ Achieved!':`<span style="color:var(--green);font-weight:600">${a.progress}%</span> verified&thinsp;/&thinsp;<span style="color:var(--muted)">${a.allProgress}%</span> total &nbsp;·&nbsp; ${a.verifiedHours}&thinsp;/&thinsp;${a.hours} hrs`}</div>
        </div>
      </div>`).join('');
  } catch {}
}

// ── PROFILE ───────────────────────────────────
function initChips() {
  document.getElementById('pf-skills-chips').innerHTML = SKILLS.map(s=>`<span class="chip" data-action="toggleOn">${s}</span>`).join('');
  document.getElementById('pf-causes-chips').innerHTML = CAUSES.map(c=>`<span class="chip" data-action="toggleOn">${c}</span>`).join('');
  document.getElementById('p-skills-chips').innerHTML = SKILLS.map(s=>`<span class="chip" data-action="toggleOn">${s}</span>`).join('');
  if (currentUser?.skills) document.querySelectorAll('#pf-skills-chips .chip').forEach(c=>c.classList.toggle('on',currentUser.skills.includes(c.textContent)));
  if (currentUser?.causes) document.querySelectorAll('#pf-causes-chips .chip').forEach(c=>c.classList.toggle('on',currentUser.causes.includes(c.textContent)));
}

async function saveProfile() {
  const skills = [...document.querySelectorAll('#pf-skills-chips .chip.on')].map(c=>c.textContent);
  const causes = [...document.querySelectorAll('#pf-causes-chips .chip.on')].map(c=>c.textContent);
  try {
    const updated = await api('/api/profile',{method:'PUT',body:JSON.stringify({school:val('pf-school'),grade:val('pf-grade'),location:val('pf-location'),skills,causes,emailNotifications:document.getElementById('pf-email-notifs').checked})});
    currentUser={...currentUser,...updated};
    toast('Profile saved!');
  } catch(e){ toast(e.message,'err'); }
}

async function saveOrgProfile() {
  try {
    const updated = await api('/api/profile',{method:'PUT',body:JSON.stringify({orgName:val('org-pf-name'),description:val('org-pf-desc'),website:val('org-pf-website'),phone:val('org-pf-phone'),emailNotifications:document.getElementById('org-pf-email-notifs').checked})});
    currentUser={...currentUser,...updated};
    setText('ods-name', currentUser.orgName||'');
    setText('ods-avatar', (currentUser.orgName||'O').charAt(0).toUpperCase());
    toast('Profile saved!');
  } catch(e){ toast(e.message,'err'); }
}

// ── ORG DASHBOARD ─────────────────────────────
async function loadOrgDash() {
  if (!currentUser||currentUser.role!=='org') return;
  nav('org-dash');
  const u = currentUser;
  const statusColor = u.adminApproved?'var(--green)':u.reviewStatus==='rejected'?'var(--red)':'var(--amber)';
  const statusLabel = u.adminApproved?'✓ Approved':u.reviewStatus==='rejected'?'✕ Rejected':'⏳ Pending Review';
  document.getElementById('ods-status-badge').innerHTML = `<span style="font-size:.75rem;font-weight:700;padding:4px 10px;border-radius:100px;background:${statusColor}22;color:${statusColor}">${statusLabel}</span>`;
  if (!u.adminApproved) {
    document.getElementById('org-listings-grid').innerHTML = `<div class="empty"><div class="empty-icon">⏳</div><strong>Your organization is pending admin review.</strong><br><span style="font-size:.83rem;color:var(--muted)">Listings will go live once approved. This usually takes 24–48 hours.</span></div>`;
  } else {
    await loadOrgListings();
  }
  const orgOpps = allOpps.filter(o=>o.orgId===u.orgId);
  renderCal('org-cal-root', orgOpps);
  loadOrgApplicants();
  loadBillingMe();
  api('/api/hours').then(hrs=>setTabBadge('otab-hours',hrs.filter(h=>h.status==='pending').length)).catch(()=>{});
  document.getElementById('org-pf-name').value = u.orgName||'';
  document.getElementById('org-pf-desc').value = u.description||'';
  document.getElementById('org-pf-website').value = u.website||'';
  document.getElementById('org-pf-phone').value = u.phone||'';
  document.getElementById('org-pf-email-notifs').checked = u.emailNotifications!==false;
  renderMfaSection('mfa-section-org');
}

async function loadOrgListings() {
  try {
    const opps = await api('/api/org/opportunities');
    const now = new Date();
    const isRecurring = o => o.commitment === 'Weekly' || o.commitment === 'Monthly';
    // Expired = one-time, end time passed (regardless of active flag)
    const isExpired = o => !isRecurring(o) && o.endTime && new Date(o.endTime) < now;

    const activeOpps  = opps.filter(o => !isExpired(o));
    const historyOpps = opps.filter(o =>  isExpired(o)).sort((a,b)=>new Date(b.endTime)-new Date(a.endTime));

    function renderCard(o, inHistory) {
      const fmtCls=((o.format||'').toLowerCase()==='remote'||(o.location||'').toLowerCase().includes('remote'))?'format-remote':((o.format||'').toLowerCase()==='hybrid')?'format-hybrid':'';
      const formatPip=(()=>{const loc=(o.location||'').toLowerCase();const f=o.format||'';if(loc.includes('remote')||f==='Remote')return'<span class="format-pip remote">🌐 Remote</span>';if(f==='Hybrid'||loc.includes('hybrid'))return'<span class="format-pip hybrid">🔀 Hybrid</span>';return'<span class="format-pip inperson">📍 In-Person</span>';})();
      const recurBadge = isRecurring(o) ? `<span class="badge badge-skill" style="font-size:.65rem">🔄 ${o.commitment}</span>` : '';
      const statusBadge = inHistory
        ? `<span class="badge badge-denied" style="opacity:.7">Expired</span>`
        : `<span class="badge ${o.active?'badge-verified':'badge-denied'}">${o.active?'Active':'Inactive'}</span>`;
      const buttons = inHistory
        ? `<button class="btn-s" style="padding:6px 12px;font-size:.75rem;color:var(--red);border-color:var(--red)" data-action="permanentDeleteOpp" data-args="${esc(JSON.stringify([o.id]))}">🗑 Remove</button>`
        : o.active
          ? `<button class="btn-s" style="padding:6px 12px;font-size:.75rem" data-action="openChat" data-args="${esc(JSON.stringify([o.id, o.title]))}">💬</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem" title="Copy listing link" data-action="copyOppLink" data-args="${esc(JSON.stringify([o.id]))}">🔗</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem" title="Event check-in code" data-action="openCheckinCode" data-args="${esc(JSON.stringify([o.id]))}">🎫 Code</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem" data-action="openEditModal" data-args="${esc(JSON.stringify([o]))}">✏️ Edit</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem" data-action="duplicateOpp" data-args="${esc(JSON.stringify([o]))}">⧉ Duplicate</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem;color:#8a6d1d;border-color:var(--gold)" data-action="toggleFeature" data-args="${esc(JSON.stringify([o.id, !o.featured]))}">${o.featured?'★ Unfeature':'☆ Feature'}</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem;color:var(--amber);border-color:var(--amber)" data-action="deactivateOpp" data-args="${esc(JSON.stringify([o.id]))}">Deactivate</button>`
          : `<button class="btn-s" style="padding:6px 12px;font-size:.75rem;color:var(--green);border-color:var(--green)" data-action="reactivateOpp" data-args="${esc(JSON.stringify([o.id]))}">♻️ Reactivate</button>
             <button class="btn-s" style="padding:6px 12px;font-size:.75rem;color:var(--red);border-color:var(--red)" data-action="permanentDeleteOpp" data-args="${esc(JSON.stringify([o.id]))}">🗑 Remove</button>`;
      return `<div class="opp-card ${fmtCls}${inHistory?' opp-card-expired':''}${o.featured?' featured':''}">
        <div class="oc-top"><div class="oc-avatar" style="background:${o.bg||'#e8f5ef'}">${o.emoji||'🏛️'}</div><div style="display:flex;gap:5px;flex-wrap:wrap">${o.featured?'<span class="badge badge-featured">★ Featured</span>':''}${statusBadge}${recurBadge}</div></div>
        <div class="oc-title">${esc(o.title)}</div>
        <div style="margin-bottom:6px">${formatPip}</div>
        <div class="oc-meta" style="margin-top:4px"><span>📅 ${fmtDate(o.startTime)}</span><span>⏱ ${fmt(o.durationHours)} hrs</span><span>👥 ${o.spotsRemaining}/${o.spotsAvailable}</span></div>
        <div class="oc-footer">
          <span style="font-size:.73rem;color:var(--muted)">${o.applicantCount||0} volunteers</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${buttons}</div>
        </div>
      </div>`;
    }

    const grid = document.getElementById('org-listings-grid');
    grid.innerHTML = activeOpps.length
      ? activeOpps.map(o => renderCard(o, false)).join('')
      : '<div class="empty"><div class="empty-icon">📋</div>No listings yet. Click ＋ Add Listing to get started.</div>';

    const hgrid = document.getElementById('org-history-grid');
    hgrid.innerHTML = historyOpps.length
      ? historyOpps.map(o => renderCard(o, true)).join('')
      : '<div class="empty"><div class="empty-icon">🗂️</div>No expired listings yet.</div>';

    const total = opps.reduce((s,o)=>s+(o.applicantCount||0),0);
    setText('ods-listings', activeOpps.filter(o=>o.active).length);
    setText('ods-volunteers', total);
  } catch(e){ console.error(e); }
}

async function loadOrgApplicants() {
  try {
    const apps = await api('/api/applications/org');
    const list = document.getElementById('org-apps-list');
    if (!apps.length) { list.innerHTML='<div class="empty"><div class="empty-icon">👥</div>No applicants yet.</div>'; setText('ods-pending',0); setTabBadge('otab-applicants',0); return; }
    const pending = apps.filter(a=>a.status==='pending');
    setText('ods-pending', pending.length);
    setTabBadge('otab-applicants', pending.length);
    list.innerHTML = `<table class="tbl"><thead><tr><th>Student</th><th>Opportunity</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>
      ${apps.map(a=>`<tr>
        <td><strong>${esc(a.userName)}</strong><br><span style="font-size:.75rem;color:var(--muted)">${esc(a.userEmail)}</span></td>
        <td style="font-size:.83rem">${esc(a.oppTitle)}</td>
        <td><span class="status-pill sp-${a.status}">${a.status}</span></td>
        <td style="font-size:.78rem;color:var(--muted)">${fmtDate(a.createdAt)}</td>
        <td>${a.status==='pending'?`<div style="display:flex;gap:6px"><button class="btn-approve" data-action="reviewApp" data-args="${esc(JSON.stringify([a.id,'approve']))}" aria-label="Approve ${esc(a.userName)}">✓</button><button class="btn-reject" data-action="reviewApp" data-args="${esc(JSON.stringify([a.id,'reject']))}" aria-label="Reject ${esc(a.userName)}">✕</button></div>`:a.status==='approved'?`<button class="btn-s" style="padding:4px 10px;font-size:.7rem" data-action="openEndorseModal" data-args="${esc(JSON.stringify([a.userId, a.userName, a.oppId, a.oppTitle]))}">🌟 Endorse</button>`:''}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch {}
}

async function reviewApp(id, action) {
  try {
    await api('/api/applications/'+id,{method:'PATCH',body:JSON.stringify({action})});
    loadOrgApplicants(); loadOrgListings();
    toast(action==='approve'?'Applicant approved!':'Application declined');
  } catch(e){ toast(e.message,'err'); }
}

async function loadOrgHours() {
  const list = document.getElementById('org-hours-list');
  list.innerHTML='<div class="loading"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    const hours = await api('/api/hours');
    setTabBadge('otab-hours', hours.filter(h=>h.status==='pending').length);
    if (!hours.length) { list.innerHTML='<div class="empty"><div class="empty-icon">✅</div>No pending hour requests.</div>'; return; }
    list.innerHTML = `<table class="tbl"><thead><tr><th>Student</th><th>Activity</th><th>Date</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>
      ${hours.map(h=>`<tr id="hr-${h.id}">
        <td><strong>${esc(h.studentName||'—')}</strong><br><span style="font-size:.75rem;color:var(--muted)">${esc(h.studentEmail||'')}</span></td>
        <td style="font-size:.83rem">${esc(h.activity)}</td>
        <td style="font-size:.78rem">${fmtDate(h.startTime)}</td>
        <td><strong>${fmt(h.hours)}</strong></td>
        <td><span class="status-pill sp-${h.status}">${h.status}</span></td>
        <td>${h.status==='pending'?`<div style="display:flex;gap:6px"><button class="btn-approve" data-action="verifyHr" data-args="${esc(JSON.stringify([h.id,'approve']))}">✓ Verify</button><button class="btn-reject" data-action="verifyHr" data-args="${esc(JSON.stringify([h.id,'deny']))}">✕ Deny</button></div>`:''}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch(e){ list.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}

async function verifyHr(id, action) {
  try {
    await api('/api/hours/'+id+'/verify',{method:'PATCH',body:JSON.stringify({action:action==='approve'?'approve':'deny',supervisorName:currentUser?.orgName})});
    loadOrgHours();
    toast(action==='approve'?'Hours verified!':'Hours denied');
  } catch(e){ toast(e.message,'err'); }
}

async function deactivateOpp(id) {
  const deactOk = await _showDialog({icon:'⏸️', title:'Deactivate this listing?', msg:'It will be hidden from students but can be reactivated at any time.', confirmText:'Deactivate'});
  if (!deactOk) return;
  try { await api('/api/opportunities/'+id,{method:'DELETE'}); loadOrgListings(); toast('Listing deactivated.'); } catch(e){ toast(e.message,'err'); }
}

async function reactivateOpp(id) {
  try { await api('/api/opportunities/'+id+'/reactivate',{method:'PATCH'}); loadOrgListings(); toast('Listing reactivated! ✅'); } catch(e){ toast(e.message,'err'); }
}

async function permanentDeleteOpp(id) {
  const permOk = await _showDialog({icon:'🗑️', title:'Permanently remove this listing?', msg:'This cannot be undone. All applicants and messages for this listing will also be deleted.', confirmText:'Remove Forever', danger:true});
  if (!permOk) return;
  try { await api('/api/opportunities/'+id+'/permanent',{method:'DELETE'}); loadOrgListings(); toast('Listing permanently removed.'); } catch(e){ toast(e.message,'err'); }
}

// EDIT LISTING
let editingOppId = null;
function openEditModal(opp) {
  const hoursUntil = (new Date(opp.startTime) - Date.now()) / 36e5;
  if (hoursUntil < 48) {
    toast('Events can only be edited at least 2 days before they start.', 'err');
    return;
  }
  editingOppId = opp.id;
  // Pre-fill the post modal with existing values
  document.getElementById('post-err').style.display = 'none';
  document.getElementById('p-title').value = opp.title || '';
  document.getElementById('p-desc').value = opp.description || '';
  document.getElementById('p-loc').value = opp.location || '';
  document.getElementById('p-spots').value = opp.spotsAvailable || '';
  document.getElementById('p-minage').value = opp.minAge || '';
  document.getElementById('p-approval').checked = !!opp.requiresApproval;
  // Set date-time pickers
  setDT('p-start', opp.startTime);
  setDT('p-end', opp.endTime);
  // Set selects
  const setSelect = (id, val) => { const el=document.getElementById(id); if(el) el.value=val||''; };
  setSelect('p-cat', opp.category);
  setSelect('p-commit', opp.commitment);
  setSelect('p-format', opp.format || (opp.location?.toLowerCase().includes('remote')?'Remote':'In-Person'));

  // Skills chips
  document.querySelectorAll('#p-skills-chips .chip').forEach(c => c.classList.toggle('on', (opp.skills||[]).includes(c.textContent)));
  // Change modal title and button
  document.querySelector('#post-overlay .mtitle').textContent = 'Edit Opportunity';
  document.getElementById('post-btn').textContent = 'Save Changes';
  document.getElementById('post-btn').onclick = submitEdit;
  openM('post-overlay');
}

async function submitEdit() {
  const err = document.getElementById('post-err'); err.style.display='none';
  const payload = {
    title:val('p-title'), category:val('p-cat'), location:val('p-loc'),
    startTime:val('p-start'), endTime:val('p-end'),
    format:val('p-format'),
    commitment:val('p-commit'), spotsAvailable:val('p-spots'),
    description:val('p-desc'), requiresApproval:document.getElementById('p-approval').checked,
    minAge:val('p-minage')||null,
    skills:[...document.querySelectorAll('#p-skills-chips .chip.on')].map(c=>c.textContent)
  };
  if (!payload.title||!payload.category||!payload.location||!payload.startTime||!payload.endTime||!payload.description||!payload.spotsAvailable) {
    err.textContent='Please fill in all required fields.'; err.style.display='block'; return;
  }
  try {
    document.getElementById('post-btn').disabled=true;
    await api('/api/opportunities/'+editingOppId,{method:'PUT',body:JSON.stringify(payload)});
    closeM('post-overlay');
    // Reset modal back to "post" mode
    document.querySelector('#post-overlay .mtitle').textContent = 'Post a Volunteering Opportunity';
    document.getElementById('post-btn').textContent = 'Post Opportunity';
    document.getElementById('post-btn').onclick = submitListing;
    editingOppId = null;
    loadOrgListings();
    toast('Listing updated! ✅');
    document.getElementById('post-btn').disabled=false;
  } catch(e){ err.textContent=e.message; err.style.display='block'; document.getElementById('post-btn').disabled=false; }
}

// POST LISTING
function openPostModal() {
  document.getElementById('post-err').style.display='none';
  document.getElementById('p-title').value=''; document.getElementById('p-desc').value=''; document.getElementById('p-minage').value='';
  document.getElementById('p-start').value=''; document.getElementById('p-end').value='';
  document.getElementById('p-spots').value=''; document.getElementById('p-loc').value='';
  document.getElementById('p-approval').checked=false;
  document.querySelectorAll('#p-skills-chips .chip').forEach(c=>c.classList.remove('on'));
  // Reset to post mode (in case edit modal was used last)
  document.querySelector('#post-overlay .mtitle').textContent = 'Post a Volunteering Opportunity';
  document.getElementById('post-btn').textContent = 'Post Opportunity';
  document.getElementById('post-btn').onclick = submitListing;
  editingOppId = null;
  openM('post-overlay');
}

async function submitListing() {
  const err = document.getElementById('post-err'); err.style.display='none';
  const payload = {
    title:val('p-title'), category:val('p-cat'), location:val('p-loc'),
    startTime:val('p-start'), endTime:val('p-end'),
    format:val('p-format'),
    commitment:val('p-commit'), spotsAvailable:val('p-spots'),
    description:val('p-desc'), requiresApproval:document.getElementById('p-approval').checked,
    minAge:val('p-minage')||null,
    skills:[...document.querySelectorAll('#p-skills-chips .chip.on')].map(c=>c.textContent)
  };
  if (!payload.title||!payload.category||!payload.location||!payload.startTime||!payload.endTime||!payload.description||!payload.spotsAvailable) {
    err.textContent='Please fill in all required fields.'; err.style.display='block'; return;
  }
  try {
    document.getElementById('post-btn').disabled=true;
    await api('/api/opportunities',{method:'POST',body:JSON.stringify(payload)});
    closeM('post-overlay'); loadOrgListings(); toast('Listing posted! 🎉');
    document.getElementById('post-btn').disabled=false;
  } catch(e){ err.textContent=e.message; err.style.display='block'; document.getElementById('post-btn').disabled=false; }
}

// ── CHAT ──────────────────────────────────────
async function openChat(oppId, title) {
  if (!currentUser) { openAuth('login'); return; }
  currentChatOppId = oppId;
  setText('chat-m-title','Messages');
  setText('chat-m-sub', title||'');
  document.getElementById('chat-msgs').innerHTML='<div class="loading"><div class="spinner"></div></div>';
  openM('chat-overlay');
  try {
    const msgs = await api('/api/messages/'+oppId);
    renderMsgs(msgs);
  } catch(e){ document.getElementById('chat-msgs').innerHTML=`<div class="empty">${esc(e.message)}</div>`; }
}

function renderMsgs(msgs) {
  const container = document.getElementById('chat-msgs');
  if (!msgs.length) { container.innerHTML='<div class="empty" style="padding:20px">No messages yet. Be the first!</div>'; return; }
  container.innerHTML = msgs.map(m=>{
    const mine = m.senderId===currentUser?.id;
    return `<div class="chat-msg ${mine?'mine':'theirs'}">
      <div class="chat-bubble">${esc(m.text)}</div>
      <div class="chat-meta">${mine?'You':esc(m.senderName)} · ${fmtDateTime(m.createdAt)}</div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendMsg() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text||!currentChatOppId) return;
  try {
    const msg = await api('/api/messages/'+currentChatOppId,{method:'POST',body:JSON.stringify({text})});
    input.value='';
    const msgs = await api('/api/messages/'+currentChatOppId);
    renderMsgs(msgs);
  } catch(e){ toast(e.message,'err'); }
}

// ── ORG LANDING ───────────────────────────────
async function openOrgLanding(orgId) {
  if (!orgId) return;
  try {
    const data = await api('/api/org/'+orgId+'/profile');
    const avgStars = data.avgRating ? '⭐'.repeat(Math.round(data.avgRating)) + ` ${data.avgRating}` : 'No reviews yet';
    document.getElementById('org-landing-content').innerHTML = `
      <div class="org-hero">
        <div class="wrap" style="padding-top:0;padding-bottom:0">
          <div style="font-size:2.5rem;margin-bottom:10px">${data.verified?'🏛️':'🏗️'}</div>
          <h2 class="org-hero-name">${esc(data.orgName)}</h2>
          ${data.verified?'<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.1);padding:4px 12px;border-radius:100px;font-size:.78rem;margin-bottom:8px">✓ Vetted Organization</div>':''}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${(data.badges||[]).filter(b=>b!=='verified').map(b=>{const L={'top-rated':'⭐ Top Rated',responsive:'⚡ Fast Response',established:'🏛 Established'};return '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.15);padding:4px 10px;border-radius:100px;font-size:.72rem;font-weight:600">'+L[b]+'</span>';}).join('')}</div>
          <p class="org-hero-desc">${esc(data.description||'No description provided.')}</p>
          <div style="margin-top:12px;font-size:.82rem;color:rgba(255,255,255,.6)">
            ${data.website?`<a href="${safeHref(data.website)}" target="_blank" rel="noopener noreferrer" style="color:var(--gold-l)">${esc(data.website)}</a> · `:''}
            ${data.totalVolunteers} volunteers · ${data.opportunities.length} listings · ${avgStars}
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn-p" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3)" data-action="copyOrgLink" data-args="${esc(JSON.stringify([orgId]))}">🔗 Share Page</button>
            ${currentUser?.role==='student'?`<button class="btn-p" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3)" data-action="openReport" data-args="${esc(JSON.stringify([orgId]))}">⚑ Report</button>`:''}
          </div>
        </div>
      </div>
      <div class="section">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:28px">
          <div>
            <h3 style="margin-bottom:16px;color:var(--dark)">Active Opportunities</h3>
            ${data.opportunities.length?data.opportunities.map(o=>`
              <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;cursor:pointer" data-action="openOpp" data-args="${esc(JSON.stringify([o.id]))}">
                <div style="font-weight:600;font-size:.9rem;color:var(--dark);margin-bottom:4px">${esc(o.title)}</div>
                <div style="font-size:.78rem;color:var(--muted)">${fmtDate(o.startTime)} · ${fmt(o.durationHours)} hrs · ${o.spotsRemaining} spots left</div>
              </div>`).join(''):'<div class="empty">No active listings.</div>'}
          </div>
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <h3 style="color:var(--dark)">Reviews</h3>
              <button class="btn-s" style="padding:7px 16px;font-size:.8rem" data-action="openReviewsPage" data-args="${esc(JSON.stringify([orgId]))}">See all reviews →</button>
            </div>
            ${data.avgRating?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;background:var(--green-pale);border-radius:10px;padding:12px 16px">
              <div style="font-family:var(--font-display);font-size:2rem;color:var(--dark)">${data.avgRating}</div>
              <div>
                <div style="display:flex;gap:2px">${[1,2,3,4,5].map(n=>`<span style="color:${n<=Math.round(data.avgRating)?'#f59e0b':'#d1d5db'};font-size:1.1rem">★</span>`).join('')}</div>
                <div style="font-size:.75rem;color:var(--muted);margin-top:2px">${data.reviews.length} review${data.reviews.length!==1?'s':''}</div>
              </div>
            </div>`:''}
            ${data.reviews.slice(0,2).map(r=>`
              <div class="review-card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                  <div class="review-author">${esc(r.userName)}</div>
                  <div style="display:flex;gap:1px">${[1,2,3,4,5].map(n=>`<span style="color:${n<=r.rating?'#f59e0b':'#d1d5db'};font-size:.85rem">★</span>`).join('')}</div>
                </div>
                <div class="review-text">${esc(r.comment||'No comment left.')}</div>
              </div>`).join('')}
            ${!data.reviews.length?'<div style="font-size:.85rem;color:var(--muted);margin-bottom:12px">No reviews yet. Be the first!</div>':''}
            ${currentUser?.role==='student'?`<button class="btn-p" style="margin-top:10px;padding:9px 18px;font-size:.82rem" data-action="leaveReview" data-args="${esc(JSON.stringify([orgId]))}">✍️ Write a Review</button>`:''}
          </div>
        </div>
      </div>`;
    nav('org-landing');
    pushHash('org/'+orgId);
  } catch(e){ toast(e.message,'err'); }
}

function openOrgLandingFromModal() {
  const orgId = document.getElementById('opp-m-org').dataset.orgid;
  if (orgId) { closeM('opp-overlay'); openOrgLanding(orgId); }
}

let reviewTargetOrgId = null;
let reviewStarVal = 0;
const STAR_LABELS = {1:'Poor',2:'Fair',3:'Good',4:'Very Good',5:'Excellent'};

function leaveReview(orgId) {
  reviewTargetOrgId = orgId;
  reviewStarVal = 0;
  document.getElementById('review-comment').value = '';
  document.getElementById('review-err').style.display = 'none';
  document.getElementById('review-star-label').textContent = '';
  document.querySelectorAll('#review-stars-row .rsb').forEach(s=>s.className='rsb dim');
  openM('review-overlay');
}

function setReviewStar(n) {
  reviewStarVal = n;
  document.querySelectorAll('#review-stars-row .rsb').forEach(s=>{
    const v = parseInt(s.dataset.v);
    s.className = v <= n ? 'rsb lit' : 'rsb dim';
  });
  document.getElementById('review-star-label').textContent = STAR_LABELS[n] || '';
}

async function submitReview() {
  const err = document.getElementById('review-err');
  err.style.display = 'none';
  if (!reviewStarVal) { err.textContent='Please select a star rating.'; err.style.display='block'; return; }
  const comment = document.getElementById('review-comment').value.trim();
  try {
    const btn = document.querySelector('#review-overlay .fsubmit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    await api('/api/reviews/'+reviewTargetOrgId, {method:'POST', body:JSON.stringify({rating:reviewStarVal, comment})});
    closeM('review-overlay');
    toast('Review submitted! ⭐');
    openOrgLanding(reviewTargetOrgId);
    btn.disabled = false; btn.textContent = 'Submit Review';
  } catch(e) {
    err.textContent = e.message; err.style.display='block';
    const btn = document.querySelector('#review-overlay .fsubmit');
    btn.disabled = false; btn.textContent = 'Submit Review';
  }
}

async function deleteReview(reviewId, orgId) {
  const delRevOk = await _showDialog({icon:'⭐', title:'Delete your review?', msg:'Your review will be permanently removed.', confirmText:'Delete Review', danger:true});
  if (!delRevOk) return;
  try {
    await api('/api/reviews/'+reviewId+'/delete', {method:'DELETE'});
    toast('Review deleted.');
    // Refresh wherever we are
    if (document.getElementById('view-reviews').classList.contains('active')) openReviewsPage(orgId);
    else openOrgLanding(orgId);
  } catch(e){ toast(e.message,'err'); }
}


// ── REVIEWS PAGE ──────────────────────────────
async function openReviewsPage(orgId) {
  nav('reviews');
  pushHash('reviews/'+orgId);
  const wrap = document.getElementById('reviews-page-content');
  wrap.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading reviews…</div></div>';
  try {
    const [profileData, rvData] = await Promise.all([
      api('/api/org/'+orgId+'/profile'),
      api('/api/org/'+orgId+'/reviews')
    ]);
    const {reviews, avgRating, total, distribution} = rvData;
    const myReview = reviews.find(r=>r.isOwn);
    const canReview = currentUser?.role==='student' && !myReview;
    const starsHtml = (n, size='1rem') => [1,2,3,4,5].map(i=>`<span style="color:${i<=n?'#f59e0b':'#d1d5db'};font-size:${size}">★</span>`).join('');
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <button class="btn-s" style="padding:7px 14px;font-size:.8rem" data-action="openOrgLanding" data-args="${esc(JSON.stringify([orgId]))}">← Back to ${esc(profileData.orgName)}</button>
      </div>
      <h2 style="font-size:1.6rem;color:var(--dark);margin-bottom:4px">${esc(profileData.orgName)}</h2>
      <p style="font-size:.85rem;color:var(--muted);margin-bottom:28px">Volunteer reviews</p>

      <div class="rp-header">
        <div class="rp-score">
          <div class="rp-big-num">${avgRating||'—'}</div>
          <div class="rp-stars-row">${starsHtml(Math.round(avgRating||0),'1.2rem')}</div>
          <div class="rp-count">${total} review${total!==1?'s':''}</div>
        </div>
        <div class="rp-dist">
          ${distribution.map(d=>`
            <div class="review-dist-bar">
              <div class="rdb-label">${d.stars}★</div>
              <div class="rdb-track"><div class="rdb-fill" style="width:${total?Math.round(d.count/total*100):0}%"></div></div>
              <div class="rdb-count">${d.count}</div>
            </div>`).join('')}
        </div>
        ${canReview?`<div style="flex-shrink:0"><button class="btn-p" style="padding:11px 22px" data-action="leaveReview" data-args="${esc(JSON.stringify([orgId]))}">✍️ Write a Review</button></div>`:''}
      </div>

      ${reviews.length ? reviews.map(r=>`
        <div class="review-card-full">
          <div class="rcf-top">
            <div>
              <div class="rcf-name">${esc(r.userName)}</div>
              <div class="rcf-date">${new Date(r.createdAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
            </div>
            ${r.isOwn?`<button class="rcf-del" data-action="deleteReview" data-args="${esc(JSON.stringify([r.id, orgId]))}">Delete</button>`:''}
          </div>
          <div class="rcf-stars">${[1,2,3,4,5].map(i=>`<span class="rcf-star${i>r.rating?' empty':''}">${i<=r.rating?'★':'★'}</span>`).join('')}</div>
          <div class="rcf-text">${esc(r.comment||'No written review.')}</div>
        </div>`).join('')
      : '<div class="empty"><div class="empty-icon">⭐</div>No reviews yet. Be the first to review this organization!</div>'}
    `;
  } catch(e){ wrap.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}

// ── REPORTS ───────────────────────────────────
function openReport(orgId) {
  currentReportOrgId = orgId;
  document.getElementById('report-err').style.display='none';
  document.getElementById('report-reason').value='';
  document.getElementById('report-details').value='';
  openM('report-overlay');
}

async function submitReport() {
  if (!currentUser||currentUser.role!=='student') { toast('Must be logged in as student','err'); return; }
  const reason = val('report-reason'); const details = val('report-details');
  const err = document.getElementById('report-err'); err.style.display='none';
  if (!reason) { err.textContent='Please select a reason.'; err.style.display='block'; return; }
  try {
    await api('/api/reports',{method:'POST',body:JSON.stringify({orgId:currentReportOrgId,reason,details})});
    closeM('report-overlay'); toast('Report submitted. Thank you.');
  } catch(e){ err.textContent=e.message; err.style.display='block'; }
}

// ── AUTH ──────────────────────────────────────
function openAuth(mode) {
  hide('auth-role-step'); hide('auth-login-form'); hide('auth-student-form'); hide('auth-org-form'); hide('auth-forgot-form'); hide('auth-reset-form'); hide('auth-mfa-form');
  if (mode==='login') { show('auth-login-form'); setText('auth-modal-title','Welcome Back'); }
  else if (mode==='register') { show('auth-role-step'); setText('auth-modal-title','Create Your Account'); }
  else if (mode==='register-org') { show('auth-org-form'); setText('auth-modal-title','Register Your Organization'); }
  else if (mode==='forgot') { show('auth-forgot-form'); setText('auth-modal-title','Reset Your Password'); }
  else if (mode==='reset') { show('auth-reset-form'); setText('auth-modal-title','Choose a New Password'); }
  openM('auth-overlay');
}

function switchAuth(mode) {
  hide('auth-role-step'); hide('auth-login-form'); hide('auth-student-form'); hide('auth-org-form'); hide('auth-forgot-form'); hide('auth-reset-form'); hide('auth-mfa-form');
  if (mode==='login') { show('auth-login-form'); setText('auth-modal-title','Welcome Back'); }
  else if (mode==='forgot') { show('auth-forgot-form'); setText('auth-modal-title','Reset Your Password'); }
  else if (mode==='mfa') { show('auth-mfa-form'); setText('auth-modal-title','Two-Factor Code'); setTimeout(()=>document.getElementById('mfa-code')?.focus(),50); }
  else { show('auth-role-step'); setText('auth-modal-title','Create Your Account'); }
}

async function doForgot() {
  const email = val('forgot-email');
  const err = document.getElementById('forgot-err'); err.style.display='none';
  if (!email) { err.textContent='Enter your email.'; err.style.display='block'; return; }
  try {
    const r = await api('/api/auth/forgot',{method:'POST',body:JSON.stringify({email})});
    closeM('auth-overlay'); toast(r.message||'Reset link sent — check your email 📬');
  } catch(e){ err.textContent=e.message; err.style.display='block'; }
}

let _resetToken = null; // set by the #reset/<token> route
async function doReset() {
  const pw = val('reset-pw'), pw2 = val('reset-pw2');
  const err = document.getElementById('reset-err'); err.style.display='none';
  if (!pw||pw.length<8) { err.textContent='Password must be at least 8 characters.'; err.style.display='block'; return; }
  if (pw!==pw2) { err.textContent='Passwords do not match.'; err.style.display='block'; return; }
  try {
    await api('/api/auth/reset',{method:'POST',body:JSON.stringify({token:_resetToken,password:pw})});
    _resetToken=null; toast('Password updated — log in with your new password 🔑');
    switchAuth('login');
  } catch(e){ err.textContent=e.message; err.style.display='block'; }
}

function selectRole(role) {
  hide('auth-role-step');
  if (role==='student') { show('auth-student-form'); setText('auth-modal-title','Student Sign Up'); }
  else { show('auth-org-form'); setText('auth-modal-title','Organization Sign Up'); }
}

function toggleOrgOptOut() {
  const checked = document.getElementById('or-opt-out').checked;
  document.getElementById('or-manual-review-section').style.display = checked?'block':'none';
}

async function doLogin() {
  const email=val('login-email'), pw=val('login-pw');
  const err=document.getElementById('login-err'); err.style.display='none';
  if (!email||!pw){err.textContent='Email and password required.';err.style.display='block';return;}
  try {
    const res = await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password:pw})});
    if (res.mfaRequired) { _mfaToken=res.mfaToken; document.getElementById('mfa-code').value=''; switchAuth('mfa'); return; }
    token=res.token; localStorage.setItem('sl_token',token);
    setUser(res.user); closeM('auth-overlay');
    toast('Welcome back, '+(res.user.firstName||res.user.orgName||'')+'! 👋');
    if (res.user.role==='student') { await loadStudentDash(); }
    else if (res.user.role==='org') { await loadOrgDash(); }
    else if (res.user.role==='admin') { nav('admin'); loadAdmin(); }
  } catch(e){err.textContent=e.message;err.style.display='block';}
}

// ── MFA (TOTP) ────────────────────────────────
let _mfaToken = null; // login ticket from POST /api/auth/login when mfaRequired

async function doMfaVerify() {
  const code = val('mfa-code');
  const err = document.getElementById('mfa-err'); err.style.display='none';
  if (!code) { err.textContent='Enter your code.'; err.style.display='block'; return; }
  try {
    const res = await api('/api/auth/mfa/verify',{method:'POST',body:JSON.stringify({mfaToken:_mfaToken,code})});
    _mfaToken=null; token=res.token; localStorage.setItem('sl_token',token);
    setUser(res.user); closeM('auth-overlay');
    toast('Welcome back, '+(res.user.firstName||res.user.orgName||'')+'! 👋');
    if (res.user.role==='student') { await loadStudentDash(); }
    else if (res.user.role==='org') { await loadOrgDash(); }
    else if (res.user.role==='admin') { nav('admin'); loadAdmin(); }
  } catch(e){ err.textContent=e.message; err.style.display='block'; }
}

function renderMfaSection(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (currentUser?.mfaEnabled) {
    el.innerHTML = `<p style="font-size:.83rem;color:var(--green);font-weight:600;margin-bottom:10px">✓ Enabled — your account requires a code at login.</p>
      <div class="fr"><label>Code (authenticator or backup)</label><input class="fc" id="${containerId}-code" inputmode="numeric" placeholder="123456"></div>
      <button class="btn-s" data-action="mfaDisable" data-args="${esc(JSON.stringify([containerId]))}">Disable 2FA</button>`;
  } else {
    el.innerHTML = `<p style="font-size:.83rem;color:var(--muted);margin-bottom:10px">Protect your account with a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy…).</p>
      <button class="btn-s" data-action="mfaSetup" data-args="${esc(JSON.stringify([containerId]))}">Enable 2FA</button>
      <div id="${containerId}-setup"></div>`;
  }
}

async function mfaSetup(containerId) {
  try {
    const r = await api('/api/auth/mfa/setup',{method:'POST',body:'{}'});
    document.getElementById(containerId+'-setup').innerHTML = `
      <div style="margin-top:14px;padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:9px">
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:8px">1. In your authenticator app, add an account by manual entry with this secret:</p>
        <code style="display:block;word-break:break-all;font-size:.88rem;font-weight:700;margin-bottom:10px">${esc(r.secret)}</code>
        <p style="font-size:.8rem;color:var(--muted);margin-bottom:8px">2. Enter the current 6-digit code to confirm:</p>
        <div class="fr"><input class="fc" id="${containerId}-confirm" inputmode="numeric" placeholder="123456"></div>
        <button class="btn-s" data-action="mfaEnable" data-args="${esc(JSON.stringify([containerId]))}">Confirm &amp; Enable</button>
      </div>`;
  } catch(e){ toast(e.message,'err'); }
}

async function mfaEnable(containerId) {
  try {
    const code = document.getElementById(containerId+'-confirm').value;
    const r = await api('/api/auth/mfa/enable',{method:'POST',body:JSON.stringify({code})});
    currentUser.mfaEnabled = true;
    renderMfaSection(containerId);
    document.getElementById(containerId).insertAdjacentHTML('beforeend',
      `<div style="margin-top:12px;padding:12px;background:#fff8e1;border:1px solid #ffe082;border-radius:9px">
        <p style="font-size:.8rem;font-weight:700;margin-bottom:8px">Backup codes — save these now, they won't be shown again:</p>
        <code style="display:block;font-size:.82rem;line-height:1.8">${r.backupCodes.map(esc).join('<br>')}</code>
      </div>`);
    toast('Two-factor authentication enabled 🔐');
  } catch(e){ toast(e.message,'err'); }
}

async function mfaDisable(containerId) {
  try {
    const code = document.getElementById(containerId+'-code').value;
    await api('/api/auth/mfa/disable',{method:'POST',body:JSON.stringify({code})});
    toast('2FA disabled. Please log in again.');
    logout();
  } catch(e){ toast(e.message,'err'); }
}

// Shows/hides the parent/guardian fields as the DOB field changes — students
// under 18 need guardian consent (see docs/guardian-consent-spec.md); 18+
// students never see or submit these fields.
function checkStudentAge() {
  const dob = val('sr-dob');
  const fields = document.getElementById('sr-guardian-fields');
  const age = dob ? (Date.now()-new Date(dob))/(365.25*864e5) : null;
  fields.style.display = (age!==null && age<18) ? 'block' : 'none';
}

async function doStudentReg() {
  const err=document.getElementById('sreg-err'); err.style.display='none';
  const dob = val('sr-dob');
  const isMinor = dob && (Date.now()-new Date(dob))/(365.25*864e5) < 18;
  const payload={firstName:val('sr-first'),lastName:val('sr-last'),dob,email:val('sr-email'),password:val('sr-pw'),school:val('sr-school'),location:val('sr-loc')};
  if (isMinor) { payload.guardianName=val('sr-guardian-name'); payload.guardianEmail=val('sr-guardian-email'); }
  if (!payload.firstName||!payload.lastName||!payload.dob||!payload.email||!payload.password){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if (isMinor && (!payload.guardianName||!payload.guardianEmail)){err.textContent='Parent/guardian name and email are required for students under 18.';err.style.display='block';return;}
  if (payload.password.length<8){err.textContent='Password must be at least 8 characters.';err.style.display='block';return;}
  try {
    const res=await api('/api/auth/register/student',{method:'POST',body:JSON.stringify(payload)});
    token=res.token; localStorage.setItem('sl_token',token);
    setUser(res.user); closeM('auth-overlay');
    toast(res.user.guardianConsentStatus==='pending' ? 'Account created! We emailed your parent/guardian for approval.' : 'Welcome to ServeLocal! 🎉');
    await loadStudentDash();
  } catch(e){err.textContent=e.message;err.style.display='block';}
}

async function doOrgReg() {
  const err=document.getElementById('oreg-err'); err.style.display='none';
  const optOut = document.getElementById('or-opt-out').checked;
  const payload={
    orgName:val('or-name'), email:val('or-email'), confirmEmail:val('or-email2'),
    password:val('or-pw'), confirmPassword:val('or-pw2'),
    website:val('or-website'), ein:val('or-ein'),
    optOutDomainVerification:optOut,
    proofLinks:optOut?(val('or-proof')||'').split(',').map(s=>s.trim()).filter(Boolean):[],
    proofNotes:optOut?val('or-notes'):''
  };
  if (!payload.orgName||!payload.email||!payload.password){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  try {
    const res=await api('/api/auth/register/org',{method:'POST',body:JSON.stringify(payload)});
    token=res.token; localStorage.setItem('sl_token',token);
    setUser(res.user); closeM('auth-overlay');
    toast(res.message||'Organization registered!');
    await loadOrgDash();
  } catch(e){err.textContent=e.message;err.style.display='block';}
}


// ── DELETE ACCOUNT ────────────────────────────────
function openDeleteAccount() {
  document.getElementById('delete-pw-confirm').value='';
  document.getElementById('delete-account-err').style.display='none';
  const isOrg = currentUser?.role==='org';
  document.getElementById('delete-account-warning-text').innerHTML = isOrg
    ? '<strong>You are about to delete your organization account.</strong> This will permanently remove all your listings, applicant data, and messages. Volunteers who signed up for your events will lose those registrations.'
    : '<strong>You are about to delete your student account.</strong> This will permanently remove all your hours, applications, awards progress, and reviews.';
  openM('delete-account-overlay');
}

async function submitDeleteAccount() {
  const pw = document.getElementById('delete-pw-confirm').value;
  const err = document.getElementById('delete-account-err');
  err.style.display='none';
  if (!pw) { err.textContent='Please enter your password.'; err.style.display='block'; return; }
  try {
    const btn = document.querySelector('#delete-account-overlay .fsubmit');
    btn.disabled=true; btn.textContent='Deleting…';
    await api('/api/account',{method:'DELETE',body:JSON.stringify({password:pw})});
    closeM('delete-account-overlay');
    logout();
    toast('Your account has been permanently deleted.');
  } catch(e){
    err.textContent=e.message; err.style.display='block';
    const btn=document.querySelector('#delete-account-overlay .fsubmit');
    if(btn){btn.disabled=false;btn.textContent='Yes, Delete Forever';}
  }
}


// ── CHANGE PASSWORD ───────────────────────────────
function openChangePassword() {
  ['cpw-current','cpw-new','cpw-confirm'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('cpw-err').style.display='none';
  openM('change-pw-overlay');
}
async function submitChangePassword() {
  const cur = val('cpw-current'), nw = val('cpw-new'), cf = val('cpw-confirm');
  const err = document.getElementById('cpw-err'); err.style.display='none';
  const fail = m => { err.textContent=m; err.style.display='block'; };
  if (!cur || !nw) return fail('Please fill in all fields.');
  if (nw.length < 8) return fail('New password must be at least 8 characters.');
  if (nw !== cf) return fail('New passwords do not match.');
  try {
    const btn = document.querySelector('#change-pw-overlay .fsubmit');
    btn.disabled=true; btn.textContent='Updating…';
    const res = await api('/api/account/password',{method:'POST',body:JSON.stringify({currentPassword:cur,newPassword:nw})});
    if (res.token) { token=res.token; localStorage.setItem('sl_token',token); } // keep this session alive
    closeM('change-pw-overlay');
    toast('Password updated. Other devices have been signed out. 🔑');
    btn.disabled=false; btn.textContent='Update Password';
  } catch(e) { fail(e.message); const btn=document.querySelector('#change-pw-overlay .fsubmit'); if(btn){btn.disabled=false;btn.textContent='Update Password';} }
}

// ── SITE DIALOG ENGINE ────────────────────────────────────────────────
let _dialogResolve = null;

function _showDialog({icon='', title='', msg='', confirmText='Confirm', danger=false, hasInput=false, inputPlaceholder='', inputLabel=''}) {
  document.getElementById('dialog-icon').textContent = icon;
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-msg').textContent = msg;
  const btn = document.getElementById('dialog-confirm-btn');
  btn.textContent = confirmText;
  btn.className = 'dialog-btn-confirm' + (danger ? ' danger' : '');
  const inp = document.getElementById('dialog-input');
  inp.style.display = hasInput ? 'block' : 'none';
  inp.placeholder = inputPlaceholder;
  inp.value = '';
  const overlay = document.getElementById('site-dialog');
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('open'));
  if (hasInput) setTimeout(() => inp.focus(), 150);
  return new Promise(res => { _dialogResolve = res; });
}

function _dialogConfirm() {
  const inp = document.getElementById('dialog-input');
  const val = inp.style.display !== 'none' ? inp.value : true;
  _closeDialog();
  if (_dialogResolve) { _dialogResolve(val); _dialogResolve = null; }
}
function _dialogCancel() {
  _closeDialog();
  if (_dialogResolve) { _dialogResolve(null); _dialogResolve = null; }
}
function _closeDialog() {
  const overlay = document.getElementById('site-dialog');
  overlay.classList.remove('open');
  setTimeout(() => { overlay.style.display = 'none'; }, 150);
}
document.addEventListener('keydown', e => {
  const overlay = document.getElementById('site-dialog');
  if (!overlay?.classList.contains('open')) return;
  if (e.key === 'Escape') _dialogCancel();
  if (e.key === 'Enter' && document.getElementById('dialog-input').style.display === 'none') _dialogConfirm();
});

// ── ADMIN ─────────────────────────────────────
async function loadAdmin() {
  if (!currentUser||currentUser.role!=='admin') return;
  nav('admin');
  try {
    const stats = await api('/api/admin/stats');
    document.getElementById('admin-stats').innerHTML = `
      <div class="admin-stat"><div class="admin-stat-num">${stats.totalStudents}</div><div class="admin-stat-label">Students</div></div>
      <div class="admin-stat"><div class="admin-stat-num">${stats.totalOrgs}</div><div class="admin-stat-label">Organizations</div></div>
      <div class="admin-stat warn"><div class="admin-stat-num">${stats.pendingOrgs}</div><div class="admin-stat-label">Pending Review</div></div>
      <div class="admin-stat"><div class="admin-stat-num">${stats.totalOpps}</div><div class="admin-stat-label">Active Listings</div></div>
      <div class="admin-stat"><div class="admin-stat-num">${fmt(stats.totalHoursVerified)}</div><div class="admin-stat-label">Hours Verified</div></div>
      <div class="admin-stat danger"><div class="admin-stat-num">${stats.openReports}</div><div class="admin-stat-label">Open Reports</div></div>
      <div class="admin-stat"><div class="admin-stat-num">${stats.proOrgs||0}</div><div class="admin-stat-label">Pro Orgs</div></div>
      <div class="admin-stat"><div class="admin-stat-num">$${(stats.donationsTotal||0).toLocaleString()}</div><div class="admin-stat-label">Donations</div></div>`;
    loadPendingOrgs();
  } catch(e){ toast(e.message,'err'); }
}

async function loadPendingOrgs() {
  const list = document.getElementById('pending-orgs-list');
  try {
    const orgs = await api('/api/admin/orgs/pending');
    if (!orgs.length){list.innerHTML='<div class="empty"><div class="empty-icon">✅</div>No pending organizations!</div>';return;}
    list.innerHTML = orgs.map(o=>orgReviewCard(o)).join('');
  } catch(e){list.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`;}
}

async function loadAllOrgs() {
  const list = document.getElementById('all-orgs-list');
  try {
    const orgs = await api('/api/admin/orgs/all');
    list.innerHTML = orgs.map(o=>orgReviewCard(o,true)).join('');
  } catch(e){list.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`;}
}

function orgReviewCard(o, showAll=false) {
  const statusLabel = o.adminApproved?'Approved':o.reviewStatus==='rejected'?'Rejected':o.reviewStatus==='suspended'?'Suspended':'Pending';
  const statusColor = o.adminApproved?'var(--green)':o.reviewStatus==='rejected'||o.reviewStatus==='suspended'?'var(--red)':'var(--amber)';
  return `<div class="org-review-card" id="orc-${o.id}">
    <div class="orc-name">${esc(o.orgName)} <span style="font-size:.72rem;font-weight:700;padding:2px 8px;border-radius:100px;background:${statusColor}22;color:${statusColor}">${statusLabel}</span></div>
    <div class="orc-meta">
      ${esc(o.email)} · Registered ${fmtDate(o.createdAt)}<br>
      ${o.website?`Website: <a href="${safeHref(o.website)}" target="_blank" rel="noopener noreferrer">${esc(o.website)}</a><br>`:'No website · '}
      ${o.ein?`EIN: ${esc(o.ein)} · `:'No EIN · '}
      ${o.optOutDomainVerification?'<span style="color:var(--amber);font-weight:600">Opted out of domain verification</span>':'Domain email verified'}
      ${o.proofLinks?.length?`<br>Proof: ${o.proofLinks.map(l=>{const safe=/^https?:\/\//i.test(l)?esc(l):'#';return`<a href="${safe}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`;}).join(', ')}`:''}
      ${o.proofNotes?`<br><em>"${esc(o.proofNotes)}"</em>`:''}
    </div>
    <div class="orc-actions">
      ${!o.adminApproved?`<button class="btn-approve" data-action="adminAction" data-args="${esc(JSON.stringify([o.id,'approve']))}">✓ Approve</button>`:''}
      ${o.adminApproved?`<button class="btn-suspend" data-action="adminAction" data-args="${esc(JSON.stringify([o.id,'suspend']))}">Suspend</button>`:''}
      ${o.reviewStatus!=='rejected'?`<button class="btn-reject" data-action="adminAction" data-args="${esc(JSON.stringify([o.id,'reject']))}">✕ Reject</button>`:''}
      <button class="btn-s" style="padding:6px 14px;font-size:.78rem" data-action="openOrgLanding" data-args="${esc(JSON.stringify([o.orgId]))}">View Page</button>
    </div>
  </div>`;
}

async function adminAction(userId, action) {
  let note = '';
  if (action==='reject'||action==='suspend') {
    const adminNote = await _showDialog({icon: action==='reject'?'❌':'🔒', title: action==='reject'?'Reject Organization':'Suspend Organization', msg:'Add an optional note for this action:', confirmText: action==='reject'?'Reject':'Suspend', danger:true, hasInput:true, inputPlaceholder:'Reason (optional)…'});
    if (adminNote === null) return;
    note = adminNote === true ? '' : (adminNote || '');
  }
  try {
    await api('/api/admin/orgs/'+userId,{method:'PATCH',body:JSON.stringify({action,note:note||''})});
    toast(action==='approve'?'Organization approved!':action==='reject'?'Organization rejected':'Organization suspended');
    loadPendingOrgs(); loadAdmin();
  } catch(e){toast(e.message,'err');}
}

async function loadReports() {
  const list=document.getElementById('reports-list');
  try {
    const reports = await api('/api/admin/reports');
    if (!reports.length){list.innerHTML='<div class="empty"><div class="empty-icon">✅</div>No reports!</div>';return;}
    list.innerHTML=`<table class="tbl"><thead><tr><th>Organization</th><th>Reason</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody>
      ${reports.map(r=>`<tr>
        <td><strong>${esc(r.orgName)}</strong></td>
        <td style="font-size:.83rem">${esc(r.reason)}</td>
        <td style="font-size:.78rem;color:var(--muted)">${esc(r.details||'—')}</td>
        <td><span class="status-pill ${r.status==='open'?'sp-pending':'sp-verified'}">${r.status}</span></td>
        <td>${r.status==='open'?`<button class="btn-approve" data-action="resolveReport" data-args="${esc(JSON.stringify([r.id]))}">Resolve</button>`:''}</td>
      </tr>`).join('')}
    </tbody></table>`;
  } catch(e){list.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`;}
}

async function resolveReport(id) {
  try { await api('/api/admin/reports/'+id,{method:'PATCH',body:JSON.stringify({status:'resolved'})}); loadReports(); toast('Marked resolved'); } catch(e){toast(e.message,'err');}
}

function switchAdmin(tab, btn) {
  document.querySelectorAll('#view-admin .tab').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('#view-admin .tab-panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('admin-'+tab).classList.add('on');
  if (tab==='all-orgs') loadAllOrgs();
}

// ── DASH NAVIGATION ───────────────────────────
function switchDash(panel, btn) {
  document.querySelectorAll('.ds-link').forEach(l=>l.classList.remove('on'));
  document.querySelectorAll('#view-dash .tab-panel').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('dpanel-'+panel).classList.add('on');
  if (panel==='log') { populateLogOpps(); if (!allOpps.length) loadOpps(); renderQuickLog(); }
  if (panel==='impact') loadImpact();
  if (panel==='saved') loadSavedOppsPanel();
}

function switchOrgDash(panel, btn) {
  document.querySelectorAll('.ds-link').forEach(l=>l.classList.remove('on'));
  document.querySelectorAll('#view-org-dash .tab-panel').forEach(p=>p.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('opanel-'+panel).classList.add('on');
}

// ── HASH ROUTING / DEEP LINKS ─────────────────
// ── GUARDIAN CONSENT (public views — see docs/guardian-consent-spec.md) ──
let _consentToken = null;
async function loadConsentView(token) {
  _consentToken = token;
  nav('consent');
  const sub = document.getElementById('consent-sub');
  const err = document.getElementById('consent-error');
  const actions = document.getElementById('consent-actions');
  const done = document.getElementById('consent-done');
  err.style.display='none'; done.style.display='none'; actions.style.display='none';
  sub.textContent = 'Loading…';
  try {
    const r = await api('/api/consent/'+token);
    sub.textContent = `${r.studentFirstName} ${r.studentLastInitial}. wants to join ServeLocal, a platform connecting students with community service opportunities. Because they're under 18, we need your approval before they can sign up for an opportunity or message an organization.`;
    actions.style.display = 'flex';
  } catch(e) {
    sub.textContent = '';
    err.textContent = e.message;
    err.style.display = 'block';
  }
}
async function submitConsentDecision(decision) {
  const actions = document.getElementById('consent-actions');
  const done = document.getElementById('consent-done');
  const err = document.getElementById('consent-error');
  err.style.display = 'none';
  try {
    await api('/api/consent/'+_consentToken, {method:'POST', body:JSON.stringify({decision})});
    actions.style.display = 'none';
    done.style.display = 'block';
    done.textContent = decision==='approve'
      ? "Thanks! You've approved this account — we've emailed you a link to manage or revoke your approval later."
      : "You've declined this account. The student will need to contact support@servelocal.org to proceed.";
  } catch(e) { err.textContent = e.message; err.style.display = 'block'; }
}

let _consentManageToken = null;
async function loadConsentManageView(token) {
  _consentManageToken = token;
  nav('consent-manage');
  const sub = document.getElementById('consent-manage-sub');
  const err = document.getElementById('consent-manage-error');
  const actions = document.getElementById('consent-manage-actions');
  const done = document.getElementById('consent-manage-done');
  err.style.display='none'; done.style.display='none'; actions.style.display='none';
  sub.textContent = 'Loading…';
  try {
    const r = await api('/api/consent/manage/'+token);
    if (r.status==='revoked') {
      sub.textContent = '';
      done.style.display = 'block';
      done.textContent = `You've already revoked approval for ${r.studentFirstName} ${r.studentLastInitial}.'s ServeLocal account.`;
    } else {
      sub.textContent = `You previously approved ${r.studentFirstName} ${r.studentLastInitial}.'s ServeLocal account. You can revoke that approval at any time.`;
      actions.style.display = 'block';
    }
  } catch(e) {
    sub.textContent = '';
    err.textContent = e.message;
    err.style.display = 'block';
  }
}
async function confirmRevokeConsent() {
  if (!confirm('Revoke approval for this ServeLocal account? The student will no longer be able to sign up for opportunities, message organizations, or check in until approval is granted again.')) return;
  const actions = document.getElementById('consent-manage-actions');
  const done = document.getElementById('consent-manage-done');
  const err = document.getElementById('consent-manage-error');
  err.style.display = 'none';
  try {
    await api('/api/consent/manage/'+_consentManageToken, {method:'POST', body:JSON.stringify({action:'revoke'})});
    actions.style.display = 'none';
    done.style.display = 'block';
    done.textContent = 'Approval revoked.';
  } catch(e) { err.textContent = e.message; err.style.display = 'block'; }
}

let _routing = false;
function pushHash(h){
  if (_routing) return;
  const target = h ? '#'+h : '';
  if (location.hash === target || (!location.hash && !target)) return;
  try { history.pushState(null,'', target || location.pathname+location.search); } catch {}
}
async function routeFromHash(){
  const h = location.hash.replace(/^#/,'');
  _routing = true;
  try {
    if (!h) { nav('home'); return; }
    const [pathPart, hashQs] = h.split('?');
    const [page, param] = pathPart.split('/');
    if (page==='discover') { nav('discover'); restoreDiscoverFilters(hashQs); }
    else if (page==='community') { await loadCommunity(); }
    else if (page==='donate') { await loadDonate(); }
    else if (page==='pricing') { await loadPricing(); }
    else if (page==='org-info') { nav('org-info'); }
    else if (page==='privacy') { nav('privacy'); }
    else if (page==='terms') { nav('terms'); }
    else if (page==='consent'&&param) { await loadConsentView(param); }
    else if (page==='consent-manage'&&param) { await loadConsentManageView(param); }
    else if (page==='reset'&&param) { _resetToken=param; nav('home'); openAuth('reset'); history.replaceState(null,'',location.pathname); /* drop the token from the URL/history */ }
    else if (page==='dash'||page==='org-dash') {
      if (currentUser?.role==='org') await loadOrgDash();
      else if (currentUser?.role==='student') await loadStudentDash();
      else if (currentUser?.role==='admin') { nav('admin'); loadAdmin(); }
      else { nav('home'); openAuth('login'); }
    }
    else if (page==='admin') { if (currentUser?.role==='admin') { nav('admin'); loadAdmin(); } else nav('home'); }
    else if (page==='portfolio'&&param) { nav('portfolio'); loadPortfolio(param); }
    else if (page==='org'&&param) { await openOrgLanding(param); }
    else if (page==='reviews'&&param) { await openReviewsPage(param); }
    else if (page==='opp'&&param) {
      nav('discover');
      try { if (!allOpps.length) { allOpps = await api('/api/opportunities?limit=200'); renderOpps(allOpps); renderFilterChips(); } } catch {}
      try { await openOpp(param); } catch { toast('That listing is no longer available','err'); }
    }
    else nav('home');
  } finally { _routing = false; }
}
window.addEventListener('hashchange', routeFromHash);

// ── SHARE LINKS ───────────────────────────────
function copyLink(hash, msg){
  const url = location.origin + location.pathname + '#' + hash;
  navigator.clipboard.writeText(url).then(()=>toast(msg||'Link copied! 🔗')).catch(()=>toast('Could not copy link','err'));
}
function copyOppLink(id){ copyLink('opp/'+id, 'Listing link copied — share it anywhere 🔗'); }
function copyOrgLink(id){ copyLink('org/'+id, 'Page link copied! 🔗'); }

// ── SORT + RELATIVE DATES (Discover) ──────────
function applySort(list){
  const s = val('f-sort')||'soonest';
  const arr = [...list];
  if (s==='soonest') arr.sort((a,b)=>new Date(a.startTime)-new Date(b.startTime));
  else if (s==='newest') arr.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  else if (s==='spots') arr.sort((a,b)=>(b.spotsRemaining||0)-(a.spotsRemaining||0));
  else if (s==='closest') arr.sort((a,b)=>(a.distanceMiles??1e9)-(b.distanceMiles??1e9));
  arr.sort((a,b)=>(b.featured?1:0)-(a.featured?1:0)); // featured stay pinned
  return arr;
}
function relDate(d){
  if (!d) return '—';
  const today = new Date(); today.setHours(0,0,0,0);
  const ev = new Date(d); ev.setHours(0,0,0,0);
  const diff = Math.round((ev-today)/864e5);
  if (diff===0) return 'Today';
  if (diff===1) return 'Tomorrow';
  if (diff>1&&diff<=7) return 'In '+diff+' days';
  return fmtDate(d);
}

// ── SAVED OPPORTUNITIES (bookmarks) ───────────
async function toggleSaveOpp(id, ev){
  if (ev) ev.stopPropagation();
  if (!currentUser) { openAuth('login'); toast('Log in to save opportunities','err'); return; }
  if (currentUser.role!=='student') return;
  try {
    const r = await api('/api/saved-opps/'+id,{method:'PATCH'});
    currentUser.savedOpps = r.savedOpps;
    document.querySelectorAll(`[data-saveopp="${id}"]`).forEach(b=>{
      b.classList.toggle('on', r.saved);
      b.textContent = b.classList.contains('icon-heart') ? (r.saved?'♥':'♡') : (r.saved?'♥ Saved':'♡ Save');
    });
    toast(r.saved?'Saved for later 🔖':'Removed from saved');
    if (document.getElementById('dpanel-saved')?.classList.contains('on')) loadSavedOppsPanel();
  } catch(e){ toast(e.message,'err'); }
}
async function loadSavedOppsPanel(){
  const el = document.getElementById('saved-opps-list'); if (!el) return;
  const ids = currentUser?.savedOpps||[];
  if (!ids.length) { el.innerHTML='<div class="empty"><div class="empty-icon">🔖</div>Nothing saved yet. Tap the ♡ on any listing in Discover to bookmark it.</div>'; return; }
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const all = await api('/api/opportunities?limit=200');
    if (!allOpps.length) allOpps = all;
    const saved = all.filter(o=>ids.includes(o.id));
    if (!saved.length) { el.innerHTML='<div class="empty"><div class="empty-icon">🔖</div>Your saved listings are no longer active.</div>'; return; }
    el.innerHTML = saved.map(o=>`
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;gap:14px;align-items:center;cursor:pointer" data-action="openOpp" data-args="${esc(JSON.stringify([o.id]))}">
        <div class="oc-avatar" style="background:${o.bg||'#e8f5ef'};width:38px;height:38px;font-size:1rem">${o.emoji||'🏛️'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.9rem;color:var(--dark)">${esc(o.title)} ${o.featured?'<span class="badge badge-featured">★</span>':''}</div>
          <div style="font-size:.76rem;color:var(--muted)">${esc(o.orgName)} · ${relDate(o.startTime)} · ${o.spotsRemaining||0} spot${(o.spotsRemaining||0)===1?'':'s'} left</div>
        </div>
        <button class="btn-s" style="padding:6px 14px;font-size:.78rem;flex-shrink:0" data-action="openOpp" data-stop data-args="${esc(JSON.stringify([o.id]))}">View</button>
        <button class="icon-heart on" data-saveopp="${o.id}" title="Remove from saved" aria-label="Remove from saved" data-action="toggleSaveOpp" data-args="${esc(JSON.stringify([o.id]))}">♥</button>
      </div>`).join('');
  } catch(e){ el.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}

// ── EVENT CHECK-IN ────────────────────────────
async function openCheckinCode(oppId){
  try {
    const r = await api('/api/opportunities/'+oppId+'/checkin-code',{method:'POST',body:JSON.stringify({})});
    document.getElementById('checkin-code-display').textContent = r.code;
    document.getElementById('checkin-expiry').textContent = 'For '+new Date(r.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})+' · valid until '+new Date(r.expiresAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    openM('checkin-overlay');
  } catch(e){ toast(e.message,'err'); }
}
async function submitCheckin(){
  const code = val('checkin-input').trim().toUpperCase();
  if (code.length<4) { toast('Enter the code shown at your event','err'); return; }
  try {
    const r = await api('/api/checkin',{method:'POST',body:JSON.stringify({code})});
    document.getElementById('checkin-input').value='';
    toast(`Checked in! ${fmt(r.hours)} verified hours logged for "${r.activity}" ✅`);
    await loadMyHours();
    renderOnboarding();
  } catch(e){ toast(e.message,'err'); }
}

// ── HOURS GOAL ────────────────────────────────
function renderGoal(){
  const el = document.getElementById('ds-goal');
  if (!el||!currentUser||currentUser.role!=='student') return;
  const verified = myHours.filter(h=>h.status==='verified').reduce((s,h)=>s+h.hours,0);
  const goal = currentUser.hoursGoal||0;
  if (!goal) { el.innerHTML = `<a style="font-size:.78rem;font-weight:600;cursor:pointer" data-action="setHoursGoal">🎯 Set an hours goal</a>`; return; }
  const pct = Math.min(100,Math.round(verified/goal*100));
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
      <span style="font-size:.74rem;font-weight:700;color:var(--dark)">🎯 My Goal</span>
      <a style="font-size:.7rem;cursor:pointer;color:var(--muted)" data-action="setHoursGoal">edit</a>
    </div>
    <div class="progress-bar"><div class="progress-fill${pct>=100?' done':''}" style="width:${pct}%"></div></div>
    <div style="font-size:.72rem;color:var(--muted);margin-top:4px">${fmt(verified)} / ${goal} hrs ${pct>=100?'— crushed it! 🎉':'('+pct+'%)'}</div>`;
}
async function setHoursGoal(){
  const v = await _showDialog({icon:'🎯', title:'Set Your Hours Goal', msg:'How many verified volunteer hours are you aiming for? (e.g. 50 for the Presidential Bronze award)', confirmText:'Set Goal', hasInput:true, inputPlaceholder:'e.g. 100'});
  if (v===null) return;
  const n = parseInt(String(v).trim(),10);
  if (!n||n<1||n>10000) { toast('Enter a number between 1 and 10,000','err'); return; }
  try {
    const u = await api('/api/profile',{method:'PUT',body:JSON.stringify({hoursGoal:n})});
    currentUser = {...currentUser,...u};
    renderGoal();
    toast('Goal set — go get it! 🎯');
  } catch(e){ toast(e.message,'err'); }
}

// ── ONBOARDING CHECKLIST ──────────────────────
function renderOnboarding(){
  const el = document.getElementById('onboard-card'); if (!el) return;
  if (localStorage.getItem('onboardDismissed')==='1'||!currentUser||currentUser.role!=='student') { el.innerHTML=''; return; }
  const steps = [
    {done:(currentUser.skills||[]).length>0, label:'Add your skills & causes', action:'gotoDashTab', arg:'profile'},
    {done:myApps.length>0, label:'Sign up for your first opportunity', action:'goDiscover'},
    {done:myHours.length>0, label:'Log or earn your first hours', action:'gotoDashTab', arg:'log'},
    {done:isCalSyncOn(), label:'Turn on calendar sync', action:'scrollCalSync'}
  ];
  const doneCount = steps.filter(s=>s.done).length;
  if (doneCount===steps.length) { el.innerHTML=''; return; }
  el.innerHTML = `<div class="onboard-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong style="font-size:.9rem;color:var(--dark)">👋 Getting started — ${doneCount}/${steps.length} done</strong>
      <button data-action="dismissOnboard" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:.75rem">Dismiss</button>
    </div>
    ${steps.map(s=>`<div class="onboard-step${s.done?' done':''}"${s.done?'':` data-action="${s.action}"${s.arg?` data-args='["${s.arg}"]'`:''}`}>${s.done?'✅':'⬜'} <span>${s.label}</span>${s.done?'':'<span style="margin-left:auto;color:var(--green);font-weight:600">→</span>'}</div>`).join('')}
  </div>`;
}

// ── TAB BADGES ────────────────────────────────
function setTabBadge(id, n){
  const btn = document.getElementById(id); if (!btn) return;
  btn.querySelector('.tab-badge')?.remove();
  if (n>0) btn.insertAdjacentHTML('beforeend',' <span class="tab-badge">'+(n>99?'99+':n)+'</span>');
}

// ── KEYBOARD: "/" focuses search ──────────────
document.addEventListener('keydown', e=>{
  if (e.key!=='/'||e.ctrlKey||e.metaKey||e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT') return;
  e.preventDefault();
  if (!document.getElementById('view-discover').classList.contains('active')) { nav('discover'); loadOpps(); }
  setTimeout(()=>document.getElementById('opp-q')?.focus(),60);
});

// ── CSV EXPORT HELPER ─────────────────────────
function downloadCSV(filename, rows){
  const csv = rows.map(r=>r.map(c=>{ c=String(c??''); return /[",\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c; }).join(',')).join('\r\n');
  const blob = new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ── STUDENT: HOURS EXPORT & TRANSCRIPT ────────
function exportHoursCSV(){
  if (!myHours.length){ toast('No hours logged yet','err'); return; }
  downloadCSV('servelocal-hours.csv',[
    ['Date','Organization','Activity','Hours','Status','Supervisor'],
    ...myHours.map(h=>[(h.startTime||'').slice(0,10), h.orgName, h.activity, h.hours, h.status, h.supervisorName||''])
  ]);
  toast('Hours exported! ⬇');
}
function printTranscript(){
  const verified = myHours.filter(h=>h.status==='verified');
  if (!verified.length){ toast('No verified hours yet — get hours verified first','err'); return; }
  const total = Math.round(verified.reduce((s,h)=>s+h.hours,0)*100)/100;
  const rows = verified.slice().sort((a,b)=>new Date(a.startTime)-new Date(b.startTime))
    .map(h=>`<tr><td>${fmtDate(h.startTime)}</td><td>${esc(h.orgName)}</td><td>${esc(h.activity)}</td><td>${esc(h.supervisorName||'—')}</td><td style="text-align:right">${fmt(h.hours)}</td></tr>`).join('');
  const w = window.open('','_blank');
  if (!w){ toast('Pop-up blocked — allow pop-ups to print','err'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Verified Service Transcript — ${esc(currentUser.firstName+' '+currentUser.lastName)}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;color:#1a1a1a;padding:0 20px}h1{font-size:1.45rem;margin-bottom:2px}.sub{color:#555;font-size:.9rem;margin-bottom:24px}table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left}th{border-bottom:2px solid #1a1a1a;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}.total{margin-top:16px;font-size:1.05rem;font-weight:bold;text-align:right}.sig{margin-top:64px;display:flex;justify-content:space-between;gap:40px}.sig div{flex:1;border-top:1px solid #1a1a1a;padding-top:6px;font-size:.78rem;color:#555}.foot{margin-top:40px;font-size:.72rem;color:#999}</style></head><body>
<h1>Verified Community Service Transcript</h1>
<div class="sub">${esc(currentUser.firstName+' '+currentUser.lastName)}${currentUser.school?' · '+esc(currentUser.school):''}${currentUser.grade?' · '+esc(currentUser.grade):''}</div>
<table><thead><tr><th>Date</th><th>Organization</th><th>Activity</th><th>Verified By</th><th style="text-align:right">Hours</th></tr></thead><tbody>${rows}</tbody></table>
<div class="total">Total Verified Hours: ${total}</div>
<div class="sig"><div>Student Signature</div><div>Counselor / Advisor Signature</div></div>
<div class="foot">Generated by ServeLocal on ${new Date().toLocaleDateString()} — hours marked verified were confirmed by the listed organization through the ServeLocal platform.</div>
</body></html>`);
  w.document.close(); w.focus();
  setTimeout(()=>w.print(),300);
}

// ── WAITLIST ──────────────────────────────────
async function joinWaitlist(id, title){
  if (!currentUser) { openAuth('login'); return; }
  try {
    const r = await api('/api/opportunities/'+id+'/waitlist',{method:'POST'});
    await loadMyApps();
    toast(`You're #${r.position} on the waitlist for "${title}" 🕐`);
    openOpp(id);
  } catch(e){ toast(e.message,'err'); }
}
async function leaveWaitlist(id){
  try {
    await api('/api/opportunities/'+id+'/waitlist',{method:'DELETE'});
    await loadMyApps();
    toast('Left the waitlist');
    openOpp(id);
  } catch(e){ toast(e.message,'err'); }
}

// ── ORG: BILLING / PLAN ───────────────────────
async function loadBillingMe(){
  const box = document.getElementById('ods-plan-box');
  if (!box || currentUser?.role!=='org') return;
  try {
    const b = await api('/api/billing/me');
    currentUser.plan = b.plan;
    if (b.plan==='pro') {
      box.innerHTML = `<span class="plan-chip pro">⭐ Pro</span>
        <div class="plan-usage">Unlimited listings · ${b.featuredListings}/${b.maxFeatured} featured<br><a data-action="loadPricing" style="color:var(--muted)">Manage plan</a></div>`;
    } else {
      box.innerHTML = `<span class="plan-chip free">Community</span>
        <div class="plan-usage">${b.activeListings}/${b.maxActiveListings} active listings<br><a data-action="loadPricing" style="color:var(--green)">Upgrade to Pro →</a></div>`;
    }
  } catch {}
}
async function toggleFeature(id, want){
  try {
    await api('/api/opportunities/'+id+'/feature',{method:'PATCH',body:JSON.stringify({featured:want})});
    await loadOrgListings(); loadBillingMe();
    toast(want?'Listing featured — pinned to the top of search! ⭐':'Listing unfeatured');
  } catch(e){
    toast(e.message,'err');
    if (/Pro feature/i.test(e.message)) loadPricing();
  }
}
function duplicateOpp(o){
  openPostModal();
  document.getElementById('p-title').value = o.title||'';
  document.getElementById('p-desc').value = o.description||'';
  document.getElementById('p-loc').value = o.location||'';
  document.getElementById('p-spots').value = o.spotsAvailable||'';
  document.getElementById('p-minage').value = o.minAge||'';
  document.getElementById('p-approval').checked = !!o.requiresApproval;
  const setSel=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||'';};
  setSel('p-cat',o.category); setSel('p-commit',o.commitment); setSel('p-format',o.format||'In-Person');
  document.querySelectorAll('#p-skills-chips .chip').forEach(c=>c.classList.toggle('on',(o.skills||[]).includes(c.textContent)));
  toast('Listing copied — pick new dates and post 📋');
}
async function bulkVerifyHours(){
  const ok = await _showDialog({icon:'✅', title:'Verify all pending hours?', msg:'Every pending hour entry for your events will be marked verified and students will be notified.', confirmText:'Verify All'});
  if (!ok) return;
  try {
    const r = await api('/api/hours/bulk-verify',{method:'PATCH'});
    loadOrgHours();
    toast(r.verified?`Verified ${r.verified} entr${r.verified===1?'y':'ies'}! ✅`:'No pending entries to verify');
  } catch(e){ toast(e.message,'err'); }
}
async function exportRoster(){
  try {
    const d = await api('/api/org/volunteers');
    if (!d.rows.length){ toast('No volunteers yet','err'); return; }
    downloadCSV('servelocal-roster.csv',[
      ['Name','Email','Opportunity','Status','Signed Up','Verified Hours'],
      ...d.rows.map(r=>[r.name,r.email,r.opportunity,r.status,r.signedUp,r.verifiedHours])
    ]);
    toast('Roster exported! ⬇');
  } catch(e){
    toast(e.message,'err');
    if (/Pro feature/i.test(e.message)) loadPricing();
  }
}

// ── ORG: ANALYTICS ────────────────────────────
async function loadOrgAnalytics(){
  const el = document.getElementById('org-analytics-content');
  if (!el) return;
  el.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    const d = await api('/api/org/analytics');
    const t = d.totals;
    const maxApps = Math.max(...d.appsByMonth.map(m=>m.count),1);
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:26px">
        ${[['👁',t.views,'Listing Views'],['📨',t.applicants,'Applications'],['✅',t.approved,'Volunteers'],['⏱',t.verifiedHours,'Hours Verified'],['📊',t.avgFillRate+'%','Avg Fill Rate'],['🔁',t.repeatVolunteers,'Repeat Volunteers']]
          .map(([i,v,l])=>`<div class="lb-stat"><div style="font-size:1.05rem;margin-bottom:2px">${i}</div><div class="lb-stat-num" style="font-size:1.45rem">${v}</div><div class="lb-stat-label">${l}</div></div>`).join('')}
      </div>
      ${d.appsByMonth.length?`
        <h4 style="font-size:.9rem;color:var(--dark);margin-bottom:12px">Applications by Month</h4>
        <div style="margin-bottom:26px">
          ${d.appsByMonth.map(m=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:.72rem;color:var(--muted);width:58px;flex-shrink:0">${m.month}</span>
            <div style="flex:1;background:var(--border);border-radius:4px;height:18px;overflow:hidden"><div style="height:100%;background:linear-gradient(90deg,var(--green),var(--green-l));border-radius:4px;width:${Math.round(m.count/maxApps*100)}%"></div></div>
            <span style="font-size:.72rem;font-weight:600;color:var(--dark);width:28px;text-align:right">${m.count}</span>
          </div>`).join('')}
        </div>`:''}
      <h4 style="font-size:.9rem;color:var(--dark);margin-bottom:12px">Per-Listing Performance</h4>
      ${d.perListing.length?`<table class="tbl"><thead><tr><th>Listing</th><th>Views</th><th>Applications</th><th>Fill Rate</th><th>Hours Verified</th></tr></thead><tbody>
        ${d.perListing.map(l=>`<tr>
          <td><strong style="color:var(--dark)">${esc(l.title)}</strong> ${l.featured?'<span class="badge badge-featured">★</span>':''}${!l.active?'<span class="badge badge-denied">Inactive</span>':''}</td>
          <td>${l.views}</td>
          <td>${l.applicants} <span style="color:var(--muted);font-size:.75rem">(${l.approved} approved)</span></td>
          <td><div style="display:flex;align-items:center;gap:8px"><div style="width:64px;background:var(--border);border-radius:4px;height:8px;overflow:hidden"><div style="height:100%;background:${l.fillRate>=80?'var(--green)':l.fillRate>=40?'var(--amber)':'#cbd5d0'};width:${l.fillRate}%"></div></div><span style="font-size:.78rem;font-weight:600">${l.fillRate}%</span></div></td>
          <td><strong>${l.verifiedHours}</strong></td>
        </tr>`).join('')}
      </tbody></table>`:'<div class="empty"><div class="empty-icon">📈</div>Post a listing to start collecting analytics.</div>'}
      ${d.plan!=='pro'?`<div style="margin-top:20px;background:var(--gold-pale);border:1px solid #ecd9a0;border-radius:14px;padding:16px 20px;font-size:.85rem;color:#8a6d1d;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span>⭐ <strong>Go further with Pro:</strong> unlimited listings, featured placement at the top of search, and volunteer roster exports.</span>
        <button class="btn-gold" style="padding:9px 18px;font-size:.82rem" data-action="loadPricing">See Pro →</button>
      </div>`:''}`;
  } catch(e){ el.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}

// ── PRICING ───────────────────────────────────
async function loadPricing(){
  nav('pricing');
  const freeCta = document.getElementById('pricing-cta-free');
  const proCta  = document.getElementById('pricing-cta-pro');
  if (!freeCta||!proCta) return;
  if (!currentUser) {
    freeCta.innerHTML = `<button class="btn-s" style="width:100%" data-action="openAuth" data-args='["register-org"]'>Start Free</button>`;
    proCta.innerHTML  = `<button class="btn-p" style="width:100%" data-action="openAuth" data-args='["register-org"]'>Get Pro</button>`;
    return;
  }
  if (currentUser.role==='student') {
    freeCta.innerHTML = `<div style="font-size:.84rem;color:var(--green);font-weight:600;text-align:center;padding:10px">🎓 You're a student — everything is already free for you 💚</div>`;
    proCta.innerHTML  = `<div style="font-size:.82rem;color:var(--muted);text-align:center;padding:10px">Plans are for organizations only.</div>`;
    return;
  }
  if (currentUser.role==='org') {
    try {
      const b = await api('/api/billing/me');
      currentUser.plan = b.plan;
      if (b.plan==='pro') {
        freeCta.innerHTML = `<button class="btn-s" style="width:100%" data-action="downgradePro">Downgrade to Community</button>`;
        proCta.innerHTML  = `<div style="text-align:center;font-weight:700;color:var(--green);font-size:.92rem;padding:11px">✓ You're on Pro ⭐</div>`;
      } else {
        freeCta.innerHTML = `<div style="text-align:center;font-weight:700;color:var(--green);font-size:.92rem;padding:11px">✓ Your current plan</div>`;
        proCta.innerHTML  = `<button class="btn-p" style="width:100%" data-action="upgradePro">Upgrade to Pro</button>`;
      }
    } catch {}
  }
}
async function upgradePro(){
  if (!currentUser || currentUser.role!=='org') { openAuth('register-org'); return; }
  const ok = await _showDialog({icon:'⭐', title:'Upgrade to ServeLocal Pro?', msg:'$19/month — unlimited listings, featured placement, analytics, and roster export. Checkout is in demo mode: no payment will be collected.', confirmText:'Upgrade (Demo)'});
  if (!ok) return;
  try {
    const r = await api('/api/billing/upgrade',{method:'POST'});
    currentUser.plan = 'pro';
    toast(r.message||'Welcome to Pro! ⭐');
    loadPricing(); loadBillingMe();
  } catch(e){ toast(e.message,'err'); }
}
async function downgradePro(){
  const ok = await _showDialog({icon:'📉', title:'Downgrade to Community?', msg:'Featured listings will be unpinned and new listings are limited to 3 active. Existing listings stay live.', confirmText:'Downgrade', danger:true});
  if (!ok) return;
  try {
    await api('/api/billing/downgrade',{method:'POST'});
    currentUser.plan = 'free';
    toast('Switched to the Community plan');
    loadPricing(); loadBillingMe();
  } catch(e){ toast(e.message,'err'); }
}

// ── COMMUNITY LEADERBOARD ─────────────────────
async function loadCommunity(){
  nav('community');
  const el = document.getElementById('community-content');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><div>Loading…</div></div>';
  try {
    const d = await api('/api/leaderboard');
    const medals = ['🥇','🥈','🥉'];
    el.innerHTML = `
      <div class="lb-band">
        <div class="lb-stat"><div class="lb-stat-num">${d.community.totalHours.toLocaleString()}</div><div class="lb-stat-label">Verified Hours</div></div>
        <div class="lb-stat"><div class="lb-stat-num">${d.community.students.toLocaleString()}</div><div class="lb-stat-label">Students</div></div>
        <div class="lb-stat"><div class="lb-stat-num">${d.community.orgs}</div><div class="lb-stat-label">Vetted Orgs</div></div>
        <div class="lb-stat"><div class="lb-stat-num">${d.community.events.toLocaleString()}</div><div class="lb-stat-label">Service Entries</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:32px" id="lb-cols">
        <div>
          <h3 style="color:var(--dark);margin-bottom:14px">🏆 Top Volunteers</h3>
          ${d.topVolunteers.length?d.topVolunteers.map((v,i)=>`
            <div class="lb-row${i<3?' podium':''}">
              <div class="lb-rank">${medals[i]||'#'+(i+1)}</div>
              <div><div class="lb-name">${esc(v.name)}</div><div class="lb-school">${esc(v.school||'—')}${v.awards?' · 🏅 '+v.awards+' award'+(v.awards>1?'s':''):''}</div></div>
              <div class="lb-hours"><b>${v.hours}</b><small>hrs verified${v.last30?' · '+v.last30+' last 30d':''}</small></div>
            </div>`).join(''):'<div class="empty"><div class="empty-icon">🚀</div>No verified hours yet — be the first on the board!</div>'}
        </div>
        <div>
          <h3 style="color:var(--dark);margin-bottom:14px">🏫 Top Schools</h3>
          ${d.topSchools.length?d.topSchools.map((s,i)=>`
            <div class="lb-row${i===0?' podium':''}">
              <div class="lb-rank">#${i+1}</div>
              <div><div class="lb-name">${esc(s.school)}</div><div class="lb-school">${s.students} active volunteer${s.students!==1?'s':''}</div></div>
              <div class="lb-hours"><b>${s.hours}</b><small>hrs</small></div>
            </div>`).join(''):'<div class="empty">Add your school to your profile to put it on the board!</div>'}
          ${currentUser?'':`<div style="margin-top:18px;text-align:center"><button class="btn-p" data-action="openAuth" data-args='["register"]'>Join the board — sign up free</button></div>`}
        </div>
      </div>`;
  } catch(e){ el.innerHTML=`<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; }
}

// ── DONATIONS (supporters) ────────────────────
let donAmt = 10;
function setDonAmt(v, btn){
  document.querySelectorAll('.don-amt').forEach(b=>b.classList.remove('on'));
  if (v===null) { donAmt = parseFloat(val('don-custom'))||0; }
  else { donAmt = v; if (btn) btn.classList.add('on'); const c=document.getElementById('don-custom'); if (c) c.value=''; }
  setText('don-btn-amt', donAmt?('$'+donAmt):'…');
}
async function submitDonation(){
  const err = document.getElementById('don-err'); err.style.display='none';
  const amt = donAmt || parseFloat(val('don-custom'))||0;
  if (!amt||amt<1) { err.textContent='Pick or enter an amount of $1 or more.'; err.style.display='block'; return; }
  try {
    const btn = document.getElementById('don-btn'); btn.disabled=true;
    await api('/api/donations',{method:'POST',body:JSON.stringify({amount:amt,name:val('don-name'),message:val('don-msg')})});
    btn.disabled=false;
    document.getElementById('don-name').value=''; document.getElementById('don-msg').value='';
    toast('Thank you for keeping ServeLocal free for students! 💚');
    loadDonate();
  } catch(e){ err.textContent=e.message; err.style.display='block'; document.getElementById('don-btn').disabled=false; }
}
async function loadDonate(){
  nav('donate');
  try {
    const d = await api('/api/donations/stats');
    setText('don-total','$'+d.totalRaised.toLocaleString());
    setText('don-count',d.donorCount);
    const rec = document.getElementById('don-recent');
    if (d.recent.length) rec.innerHTML = d.recent.map(r=>`<div class="don-recent-row"><strong>${esc(r.name)}</strong> · <span style="color:var(--green);font-weight:700">$${r.amount}</span>${r.message?`<div style="color:var(--muted);font-size:.78rem;margin-top:3px">“${esc(r.message)}”</div>`:''}</div>`).join('');
  } catch {}
}

// ── UTILS ─────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// For user strings inside single-quoted JS string literals in inline onclick handlers:
// JS-escape first, then HTML-escape (attribute entities decode BEFORE the JS engine parses).
function jsq(s){ return esc(String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")); }
// Only allow http(s) URLs in user-supplied hrefs (blocks javascript: injection)
function safeHref(u){ return /^https?:\/\//i.test(String(u||'')) ? esc(u) : '#'; }
function val(id){ const el=document.getElementById(id); return el?el.value:''; }
function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function show(id,v=true){ const el=document.getElementById(id); if(el) el.style.display=v?'':'none'; }
function hide(id){ show(id,false); }
function fmt(n){ if(n==null||isNaN(n)) return '0'; return Math.round(Number(n)*100)/100; }
function fmtDate(d){ if(!d) return '—'; return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function fmtDateTime(d){ if(!d) return '—'; return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); }
let _lastFocusedBeforeModal = null;
function openM(id){
  const el = document.getElementById(id); if(!el) return;
  _lastFocusedBeforeModal = document.activeElement;
  el.classList.add('open');
  const modal = el.querySelector('.modal,.dialog-box');
  if (modal) {
    modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('tabindex','-1');
    const focusable = modal.querySelector('input:not([type=hidden]),select,textarea,button,[href],[tabindex]:not([tabindex="-1"])');
    setTimeout(()=>{ try{ (focusable||modal).focus(); }catch{} }, 60);
  }
}
function closeM(id){
  const el = document.getElementById(id); if(!el) return;
  el.classList.remove('open');
  // Restore focus to whatever opened the modal (keyboard users don't get dumped at the top).
  if (_lastFocusedBeforeModal && _lastFocusedBeforeModal.focus) { try{ _lastFocusedBeforeModal.focus(); }catch{} _lastFocusedBeforeModal = null; }
}
function toast(msg,type=''){ const t=document.getElementById('toast'); t.textContent=msg; t.className='show'+(type?' '+type:''); clearTimeout(t._t); t._t=setTimeout(()=>t.className='',3200); }

// ── CALENDAR SYNC (subscribe via webcal:// or download .ics) ─────────
function isCalSyncOn() {
  return localStorage.getItem('calSyncOn') === '1';
}
function updateCalToggleUI() {
  const track = document.querySelector('.cal-toggle-track');
  const thumb = document.querySelector('.cal-toggle-thumb');
  if (!track || !thumb) return;
  const on = isCalSyncOn();
  track.style.background = on ? 'var(--green)' : '#ccc';
  thumb.style.left = on ? '18px' : '2px';
  // Update the info text
  const info = document.getElementById('cal-sync-info');
  if (info) info.style.display = on ? '' : 'none';
}
async function toggleCalSync() {
  const nowOn = !isCalSyncOn();
  localStorage.setItem('calSyncOn', nowOn ? '1' : '0');
  updateCalToggleUI();
  if (nowOn) {
    await subscribeCalendar();
  } else {
    toast('Calendar sync OFF');
  }
}
async function subscribeCalendar() {
  try {
    const data = await api('/api/calendar-token');
    const feedPath = '/api/calendar/' + data.userId + '/' + data.token + '.ics';
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isLocal) {
      // On localhost, webcal:// won't work for real sync — download the .ics instead
      const httpUrl = location.origin + feedPath;
      const link = document.createElement('a');
      link.href = httpUrl;
      link.download = 'servelocal-events.ics';
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      toast('Calendar downloaded! (Subscribe works after deploy)');
    } else {
      // On a real domain, open webcal:// which triggers calendar app subscription
      const webcalUrl = 'webcal://' + location.host + feedPath;
      window.location.href = webcalUrl;
      toast('Calendar subscription opened!');
    }
    // Store the feed URL for display
    localStorage.setItem('calFeedPath', feedPath);
    updateCalFeedInfo();
  } catch(e) {
    toast('Failed to get calendar link: ' + e.message, 'err');
  }
}
function updateCalFeedInfo() {
  const info = document.getElementById('cal-sync-info');
  if (!info) return;
  const feedPath = localStorage.getItem('calFeedPath');
  if (!feedPath || !isCalSyncOn()) { info.style.display = 'none'; return; }
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const httpUrl = location.origin + feedPath;
  const webcalUrl = 'webcal://' + location.host + feedPath;
  info.style.display = '';
  if (isLocal) {
    info.innerHTML = '<span style="color:var(--muted);font-size:.74rem">📋 <a href="'+httpUrl+'" target="_blank" style="color:var(--green);text-decoration:underline">Download latest .ics</a> · Live sync works after deploy</span>';
  } else {
    info.innerHTML = '<span style="color:var(--muted);font-size:.74rem">✅ Subscribed · <a href="'+webcalUrl+'" style="color:var(--green);text-decoration:underline">Re-subscribe</a> · Your calendar auto-refreshes</span>';
  }
}
// Called after sign-up or unsubscribe — re-downloads .ics if sync is on (localhost only)
function syncCalendarNow() {
  if (!isCalSyncOn()) return;
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocal) {
    // On localhost, auto-download the latest .ics
    const feedPath = localStorage.getItem('calFeedPath');
    if (feedPath) {
      const link = document.createElement('a');
      link.href = location.origin + feedPath;
      link.download = 'servelocal-events.ics';
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      toast('Calendar updated!');
    }
  }
  // On a real domain, no action needed — calendar app polls the server automatically
}

// ── DELEGATED EVENT DISPATCH (ADR-0014 step 2) ──────────────
// Inline on*= handlers were removed so CSP can drop script-src 'unsafe-inline'.
// Markup now carries a per-event attribute naming a key in ACTIONS:
//   data-action (click) / data-change / data-input / data-blur /
//   data-keydown / data-mouseover / data-mouseout
// plus an optional data-args — a JSON array of arguments written with
//   esc(JSON.stringify([...]))  (handles strings, numbers, booleans, whole
//   objects; one attribute-safe escaping path — retires jsq() for handlers)
// and an optional boolean data-stop (stopPropagation before invoking).
// Every ACTIONS entry has the uniform signature (el, ev, a) and uses only what
// it needs. Entries live inside app.js so their closures see all top-level
// bindings directly (no reliance on global-object exposure). Registry is
// grouped by surface below; keep the sentinel comment last.
const ACTIONS = {
  // —— shell / nav / discover (surface 1) ——
  nav:            (el,ev,a)=> nav(a[0]),
  openAuth:       (el,ev,a)=> openAuth(a[0]),
  openM:          (el,ev,a)=> openM(a[0]),
  closeM:         (el,ev,a)=> closeM(a[0]),
  goDiscover:     ()=>{ nav('discover'); loadOpps(); },
  goCommunity:    ()=>{ nav('community'); loadCommunity(); },
  goDonate:       ()=>{ nav('donate'); loadDonate(); },
  goPricing:      ()=>{ nav('pricing'); loadPricing(); },
  goDashboard:    ()=> requireAuth(()=> currentUser?.role==='org' ? loadOrgDash() : loadStudentDash()),
  navHomeKey:     (el,ev)=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); nav('home'); } },
  dismissBanner:  (el)=>{ el.parentElement.style.display='none'; },
  resendGuardianConsent: ()=> resendGuardianConsent(),
  onZipInput:     ()=> onZipInput(),
  onMilesChange:  ()=> onMilesChange(),
  applyZip:       ()=> applyZip(),
  useMyLocation:  ()=> useMyLocation(),
  debounce:       ()=> debounce(),
  loadOpps:       ()=> loadOpps(),
  sortOpps:       ()=> renderOpps(allOpps),
  openOpp:        (el,ev,a)=> openOpp(a[0]),
  borderGreen:    (el)=>{ el.style.borderColor='var(--green-mid)'; },
  borderClear:    (el)=>{ el.style.borderColor=''; },
  quickLog:       (el,ev,a)=> quickLog(a[0], a[1]),
  applySavedSearchById: (el,ev,a)=> applySavedSearchById(a[0]),
  deleteSavedSearch:    (el,ev,a)=> deleteSavedSearch(a[0]),
  clearZip:       ()=> clearZip(),
  clearFilter:    (el,ev,a)=> { setval(a[0],''); loadOpps(); },
  clearAllFilters:()=> clearAllFilters(),
  openOrgLanding: (el,ev,a)=> openOrgLanding(a[0]),
  toggleSaveOpp:  (el,ev,a)=> toggleSaveOpp(a[0], ev),
  // opp-detail modal
  reincludeDate:  (el,ev,a)=> reincludeDate(a[0], a[1]),
  excludeDate:    (el,ev,a)=> excludeDate(a[0], a[1], a[2]),
  unsignSingleDate:(el,ev,a)=> unsignSingleDate(a[0], a[1], a[2]),
  applyToOpp:     (el,ev,a)=> applyToOpp(a[0], a[1], a[2], a[3], a[4]),
  unsubscribeOpp: (el,ev,a)=> unsubscribeOpp(a[0], a[1]),
  leaveWaitlist:  (el,ev,a)=> leaveWaitlist(a[0]),
  joinWaitlist:   (el,ev,a)=> joinWaitlist(a[0], a[1]),
  openChat:       (el,ev,a)=> openChat(a[0], a[1]),
  copyOppLink:    (el,ev,a)=> copyOppLink(a[0]),
  scrollToDates:  ()=> document.getElementById('upcoming-dates-section')?.scrollIntoView({behavior:'smooth'}),
  loginToApply:   ()=>{ closeM('opp-overlay'); openAuth('login'); },
  // header / notifications
  logout:         ()=> logout(),
  toggleNotifPanel:(el,ev)=> toggleNotifPanel(ev),
  toggleNotifKey: (el,ev)=>{ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); toggleNotifPanel(ev); } },
  markAllNotifRead:()=> markAllNotifRead(),
  onNotifClick:   (el,ev,a)=> onNotifClick(a[0], a[1]),
  goAdmin:        ()=>{ nav('admin'); loadAdmin(); },
  goOrgDash:      ()=>{ nav('org-dash'); loadOrgDash(); },
  goStudentDash:  ()=>{ nav('dash'); loadStudentDash(); },
  // —— student dashboard (surface 2) ——
  switchDash:     (el,ev,a)=> switchDash(a[0], el),
  checkinKey:     (el,ev)=>{ if(ev.key==='Enter') submitCheckin(); },
  submitCheckin:  ()=> submitCheckin(),
  toggleCalSync:  ()=> toggleCalSync(),
  exportHoursCSV: ()=> exportHoursCSV(),
  printTranscript:()=> printTranscript(),
  filterHours:    (el,ev,a)=> filterHours(a[0], el),
  updateDtDur:    (el,ev,a)=>{ updateDT(a[0]); updateLogDur(); },
  clampHrDur:     (el,ev,a)=>{ clampHr(el); updateDT(a[0]); updateLogDur(); },
  clampMinDur:    (el,ev,a)=>{ clampMin(el); updateDT(a[0]); updateLogDur(); },
  padHr:          (el)=> padNum(el,1,12),
  padMin:         (el)=> padNum(el,0,59),
  submitLogHours: ()=> submitLogHours(),
  saveProfile:    ()=> saveProfile(),
  togglePortfolioVisibility: (el)=> togglePortfolioVisibility(el.checked),
  viewMyPortfolio:()=> viewMyPortfolio(),
  copyPortfolioLink: ()=> copyPortfolioLink(),
  openChangePassword: ()=> openChangePassword(),
  openDeleteAccount: ()=> openDeleteAccount(),
  loadMoreOpps:   ()=> loadMoreOpps(),
  openAppeal:     (el,ev,a)=> openAppeal(a[0]),
  delHour:        (el,ev,a)=> delHour(a[0]),
  colorRed:       (el)=>{ el.style.color='var(--red)'; },
  colorMuted:     (el)=>{ el.style.color='var(--muted)'; },
  calNav:         (el,ev,a)=> calNav(a[0], a[1], a[2]),
  upcomingHoverOn:(el)=>{ el.style.borderColor='var(--green-mid)'; el.style.boxShadow='var(--shadow)'; },
  upcomingHoverOff:(el)=>{ el.style.borderColor='var(--border)'; el.style.boxShadow='none'; },
  toggleOn:       (el)=> el.classList.toggle('on'),
  setHoursGoal:   ()=> setHoursGoal(),
  dismissOnboard: ()=>{ localStorage.setItem('onboardDismissed','1'); renderOnboarding(); },
  gotoDashTab:    (el,ev,a)=> switchDash(a[0], document.getElementById('dtab-'+a[0])),
  scrollCalSync:  ()=> document.getElementById('cal-sync-toggle')?.scrollIntoView({behavior:'smooth'}),
  openCheckinCode:(el,ev,a)=> openCheckinCode(a[0]),
  // —— org dashboard (surface 3) ——
  switchOrgDash:  (el,ev,a)=> switchOrgDash(a[0], el),
  orgTabAnalytics:(el)=>{ switchOrgDash('analytics', el); loadOrgAnalytics(); },
  orgTabHours:    (el)=>{ switchOrgDash('hours', el); loadOrgHours(); },
  openPostModal:  ()=> openPostModal(),
  bulkVerifyHours:()=> bulkVerifyHours(),
  exportRoster:   ()=> exportRoster(),
  saveOrgProfile: ()=> saveOrgProfile(),
  viewMyOrgPage:  ()=> openOrgLanding(currentUser?.orgId),
  permanentDeleteOpp: (el,ev,a)=> permanentDeleteOpp(a[0]),
  openEditModal:  (el,ev,a)=> openEditModal(a[0]),
  duplicateOpp:   (el,ev,a)=> duplicateOpp(a[0]),
  toggleFeature:  (el,ev,a)=> toggleFeature(a[0], a[1]),
  deactivateOpp:  (el,ev,a)=> deactivateOpp(a[0]),
  reactivateOpp:  (el,ev,a)=> reactivateOpp(a[0]),
  reviewApp:      (el,ev,a)=> reviewApp(a[0], a[1]),
  openEndorseModal:(el,ev,a)=> openEndorseModal(a[0], a[1], a[2], a[3]),
  verifyHr:       (el,ev,a)=> verifyHr(a[0], a[1]),
  updateDtPost:   (el,ev,a)=>{ updateDT(a[0]); updatePostDur(); },
  clampHrPost:    (el,ev,a)=>{ clampHr(el); updateDT(a[0]); updatePostDur(); },
  clampMinPost:   (el,ev,a)=>{ clampMin(el); updateDT(a[0]); updatePostDur(); },
  submitListing:  ()=> submitListing(),
  // —— admin (surface 4) ——
  switchAdmin:    (el,ev,a)=> switchAdmin(a[0], el),
  adminTabReports:(el)=>{ switchAdmin('reports', el); loadReports(); },
  adminAction:    (el,ev,a)=> adminAction(a[0], a[1]),
  resolveReport:  (el,ev,a)=> resolveReport(a[0]),
  // —— modals / auth / misc (surface 5) ——
  onEnter:        (el,ev,a)=>{ if(ev.key==='Enter'){ const f=ACTIONS[a[0]]; if(f) f(el,ev,[]); } },
  printWindow:    ()=> window.print(),
  scrollTop:      ()=> window.scrollTo({top:0}),
  copyOrgLink:    (el,ev,a)=> copyOrgLink(a[0]),
  openReport:     (el,ev,a)=> openReport(a[0]),
  openReviewsPage:(el,ev,a)=> openReviewsPage(a[0]),
  leaveReview:    (el,ev,a)=> leaveReview(a[0]),
  deleteReview:   (el,ev,a)=> deleteReview(a[0], a[1]),
  openOrgLandingFromModal: ()=> openOrgLandingFromModal(),
  mfaDisable:     (el,ev,a)=> mfaDisable(a[0]),
  mfaSetup:       (el,ev,a)=> mfaSetup(a[0]),
  mfaEnable:      (el,ev,a)=> mfaEnable(a[0]),
  loadPricing:    ()=> loadPricing(),
  downgradePro:   ()=> downgradePro(),
  upgradePro:     ()=> upgradePro(),
  setDonAmt:      (el,ev,a)=> setDonAmt(a[0], el),
  submitDonation: ()=> submitDonation(),
  submitConsentDecision: (el,ev,a)=> submitConsentDecision(a[0]),
  confirmRevokeConsent:  ()=> confirmRevokeConsent(),
  selectRole:     (el,ev,a)=> selectRole(a[0]),
  switchAuth:     (el,ev,a)=> switchAuth(a[0]),
  doLogin:        ()=> doLogin(),
  doForgot:       ()=> doForgot(),
  doReset:        ()=> doReset(),
  doMfaVerify:    ()=> doMfaVerify(),
  checkStudentAge:()=> checkStudentAge(),
  doStudentReg:   ()=> doStudentReg(),
  toggleOrgOptOut:()=> toggleOrgOptOut(),
  doOrgReg:       ()=> doOrgReg(),
  sendMsg:        ()=> sendMsg(),
  submitReport:   ()=> submitReport(),
  setReviewStar:  (el,ev,a)=> setReviewStar(a[0]),
  submitReview:   ()=> submitReview(),
  submitDeleteAccount: ()=> submitDeleteAccount(),
  submitChangePassword:()=> submitChangePassword(),
  submitEndorsement:   ()=> submitEndorsement(),
  saveSearch:     ()=> saveSearch(),
  ackStorageNotice:()=> ackStorageNotice(),
  dialogConfirm:  ()=> _dialogConfirm(),
  dialogCancel:   ()=> _dialogCancel(),
  dialogBackdrop: (el,ev)=>{ if(ev.target===el) _dialogCancel(); },
  // —— end actions ——
};
function _dispatch(attr){
  return (ev)=>{
    const el = ev.target.closest('[data-'+attr+']');
    if(!el) return;
    const fn = ACTIONS[el.dataset[attr]];
    if(!fn) return;
    if(el.hasAttribute('data-stop')) ev.stopPropagation();
    let a = []; const raw = el.dataset.args;
    if(raw){ try{ a = JSON.parse(raw); }catch{ a = []; } }
    fn(el, ev, a);
  };
}
// blur doesn't bubble → capture phase so the single document listener still sees it.
[['click','action',false],['change','change',false],['input','input',false],
 ['blur','blur',true],['keydown','keydown',false],['mouseover','mouseover',false],
 ['mouseout','mouseout',false]
].forEach(([type,attr,cap])=> document.addEventListener(type, _dispatch(attr), cap));

document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{ if(e.target===o) o.classList.remove('open'); }));
document.addEventListener('keydown',e=>{ if(e.key==='Escape') document.querySelectorAll('.overlay.open').forEach(o=>o.classList.remove('open')); });

// ── NAV SCROLL SHADOW ──
let _lastScroll=0;
window.addEventListener('scroll',()=>{
  const y=window.scrollY;
  document.querySelector('nav').classList.toggle('scrolled',y>10);
  // Back to top button
  const btt=document.getElementById('back-to-top');
  if(btt) btt.classList.toggle('visible',y>400);
  _lastScroll=y;
},{passive:true});

init();

/* Twemojify: replace emoji text with self-hosted PNGs (public/emoji/, the full
   Twemoji v15.1.0 set) for identical cross-platform rendering. Covers static +
   dynamic DOM via a MutationObserver. Graphemes are clustered with
   Intl.Segmenter so ZWJ sequences, flags, keycaps and skin tones map to one img.
   Only Emoji/Regional-Indicator graphemes are touched; the ©/®/™ symbols and any
   non-emoji dingbats (✓ ✕ ★ → …) stay text so they inherit colour. An emoji with
   no bundled file (e.g. newer than the set) reverts to its text automatically. */
(function(){
  var BASE='/emoji/';
  var EMOJI=/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u; // pictographic, flag, or keycap (U+20E3)
  var KEEP_TEXT={a9:1,ae:1,'2122':1};   // © ® ™ — keep as text, not images
  var MISSING=Object.create(null);      // filenames known to 404 -> leave as text
  var SKIP={SCRIPT:1,STYLE:1,TEXTAREA:1,OPTION:1,CODE:1,PRE:1};
  var SEG=(window.Intl&&Intl.Segmenter)?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;
  // Twemoji filename: drop the FE0F presentation selector unless the sequence is
  // a ZWJ sequence; join remaining code points with '-'.
  function fileName(g){
    var src=g.indexOf('‍')>=0 ? g : g.replace(/️/g,'');
    var cps=[]; for(var ch of src) cps.push(ch.codePointAt(0).toString(16));
    return cps.join('-');
  }
  function clusters(text){
    if(SEG){ var a=[]; for(var s of SEG.segment(text)) a.push(s.segment); return a; }
    return text.match(/(\p{RI}\p{RI}|\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|[\u{1f3fb}-\u{1f3ff}])*|[\s\S])/gu)||[text];
  }
  function makeImg(fn,g){
    var img=document.createElement('img');
    img.className='emoji'; img.alt=g; img.draggable=false; img.loading='lazy';
    img.addEventListener('error',function(){
      MISSING[fn]=1;
      if(img.parentNode) img.parentNode.replaceChild(document.createTextNode(g),img);
    });
    img.src=BASE+fn+'.png';
    return img;
  }
  function processText(node){
    var text=node.nodeValue; if(!text||!EMOJI.test(text)) return;
    var parts=clusters(text), frag=null, buf='';
    for(var i=0;i<parts.length;i++){
      var g=parts[i], fn;
      if(EMOJI.test(g) && !KEEP_TEXT[(fn=fileName(g))] && !MISSING[fn]){
        if(!frag) frag=document.createDocumentFragment();
        if(buf){ frag.appendChild(document.createTextNode(buf)); buf=''; }
        frag.appendChild(makeImg(fn,g));
      } else { buf+=g; }
    }
    if(frag){ if(buf) frag.appendChild(document.createTextNode(buf)); node.parentNode.replaceChild(frag,node); }
  }
  function twemojify(root){
    if(!root) return;
    if(root.nodeType===3){ var p=root.parentNode; if(p && !SKIP[p.nodeName]) processText(root); return; }
    if(root.nodeType!==1 || SKIP[root.nodeName]) return;
    var walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode:function(n){
        var p=n.parentNode;
        if(!p || SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
        if(p.classList && p.classList.contains('emoji')) return NodeFilter.FILTER_REJECT;
        return EMOJI.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes=[], n; while((n=walker.nextNode())) nodes.push(n);
    for(var i=0;i<nodes.length;i++) processText(nodes[i]);
  }
  function run(){
    twemojify(document.body);
    new MutationObserver(function(muts){
      for(var i=0;i<muts.length;i++){
        var added=muts[i].addedNodes;
        for(var j=0;j<added.length;j++) twemojify(added[j]);
      }
    }).observe(document.body,{childList:true,subtree:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run);
  else run();
})();
