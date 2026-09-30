const app = document.getElementById('app');
const saved = JSON.parse(localStorage.getItem('goblin-session') || 'null');
let session = saved;
let state = null;
let timer = null;
let poller = null;

const escapeHtml = s => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const initials = name => name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
function setSession(s) { session = s; localStorage.setItem('goblin-session', JSON.stringify(s)); }
function clearSession() { session = null; localStorage.removeItem('goblin-session'); if (poller) clearInterval(poller); }
async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(session?.token ? {'x-player-token': session.token} : {}), ...(options.headers || {}) } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Something went wrong.'); return data;
}
function shell(content, extra = '') { app.innerHTML = `<div class="page"><div class="grain"></div><header class="topbar"><div class="brand"><span class="brand-mark">✦</span> GOBLIN PR</div>${session ? `<button class="ghost small" id="leave">Leave room</button>` : ''}</header><section class="content ${extra}">${content}</section></div>`; document.getElementById('leave')?.addEventListener('click', () => { clearSession(); renderHome(); }); }
function errorBox(message) { return `<div class="error">${escapeHtml(message)}</div>`; }
function renderHome(message = '') {
  shell(`<div class="hero"><div class="eyebrow">THE WORST IDEAS WIN</div><h1>Goblin<br><em>PR Disaster</em></h1><p class="lede">A chaotic party game for the office goblins, group chat gremlins, and professional nonsense-makers.</p><div class="home-grid"><div class="card create-card"><div class="card-icon">⚡</div><h2>Create a room</h2><p>You’re the host. Put the game on a big screen and invite your crew.</p><form id="create"><label>Your name<input name="name" maxlength="18" placeholder="e.g. Snack Goblin" required /></label><button class="primary">Make a room <span>→</span></button></form></div><div class="card join-card"><div class="card-icon">☄</div><h2>Join a room</h2><p>Enter the code from your host, then pick your public goblin name.</p><form id="join"><label>Room code<input name="code" maxlength="4" placeholder="ABCD" required /></label><label>Your name<input name="name" maxlength="18" placeholder="e.g. Captain Chaos" required /></label><button class="secondary">Join the chaos <span>→</span></button></form></div></div>${message ? errorBox(message) : ''}</div>`);
  document.getElementById('create').onsubmit = async e => { e.preventDefault(); try { const name = new FormData(e.target).get('name'); const data = await request('/api/rooms', {method:'POST', body:JSON.stringify({name})}); setSession({...data, name}); await refresh(); startPolling(); } catch (err) { renderHome(err.message); } };
  document.getElementById('join').onsubmit = async e => { e.preventDefault(); try { const fd = new FormData(e.target); const code = String(fd.get('code')).toUpperCase(); const name = fd.get('name'); const data = await request(`/api/rooms/${code}/join`, {method:'POST', body:JSON.stringify({name})}); setSession({...data, name}); await refresh(); startPolling(); } catch (err) { renderHome(err.message); } };
}
async function refresh() { if (!session) return;if (document.activeElement?.matches('#answer textarea')) return; try { state = await request(`/api/rooms/${session.code}/state?token=${session.token}`); renderState(); } catch (err) { clearSession(); renderHome(err.message); } }
function startPolling() { if (poller) clearInterval(poller); poller = setInterval(refresh, 900); }
function people() { return state.players.map(p => `<div class="player"><span class="avatar">${initials(p.name)}</span><span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="crown">HOST</span>' : ''}<strong>${p.score}</strong></div>`).join(''); }
function countdown() { if (!state.endsAt) return ''; const seconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)); return `<span class="timer">0:${String(seconds).padStart(2,'0')}</span>`; }
function renderState() {
  if (!state) return;
  if (state.phase === 'lobby') return renderLobby();
  if (state.phase === 'answering') return renderAnswering();
  if (state.phase === 'voting') return renderVoting();
  if (state.phase === 'roundResult') return renderResult(false);
  if (state.phase === 'gameOver') return renderResult(true);
}
function baseGame(title, body, label = '') { shell(`<div class="game-head"><div><div class="eyebrow">ROUND ${state.round} OF ${state.totalRounds}</div><h1>${title}</h1></div><div class="room-pill">ROOM <b>${state.code}</b></div></div><div class="game-layout"><section class="main-card">${body}</section><aside><div class="side-card"><div class="side-title">GOBLINS IN THE ROOM <span>${state.players.length}/8</span></div>${people()}</div></aside></div>`, 'game-page'); }
function renderLobby() {
  shell(`<div class="lobby"><div class="eyebrow">ROOM READY</div><div class="room-code">${state.code}</div><h1>Gather the goblins.</h1><p class="lede">Share the room code. Everyone joins on their own device and uses a public name.</p><div class="lobby-grid"><div class="card invite-card"><span class="invite-label">YOUR ROOM CODE</span><strong>${state.code}</strong><p>Players can join at this address:<br><span class="url">${location.origin}</span></p><button class="secondary" id="copy">Copy invite details</button><div id="copy-note"></div></div><div class="card roster"><div class="side-title">GOBLINS IN THE ROOM <span>${state.players.length}/8</span></div>${people()}<div class="roster-note">${state.players.length < 2 ? 'Waiting for at least one more goblin…' : 'Everyone is in. Ready when you are.'}</div></div></div>${state.me?.isHost ? `<button class="primary wide" id="start" ${state.players.length < 2 ? 'disabled' : ''}>Start the disaster <span>→</span></button>` : '<div class="waiting"><span class="pulse"></span> Waiting for the host to start…</div>'}</div>`);
  document.getElementById('copy')?.addEventListener('click', async () => { await navigator.clipboard?.writeText(`Join Goblin PR Disaster at ${location.origin} and enter room code ${state.code}`); document.getElementById('copy-note').textContent = 'Copied to clipboard!'; });
  document.getElementById('start')?.addEventListener('click', async () => { await request(`/api/rooms/${state.code}/start`, {method:'POST'}); await refresh(); });
}
function renderAnswering() {
  const mine = state.me?.answerId;
  baseGame('Make it worse.', `<div class="phase-meta"><span class="phase-tag">SUBMIT YOUR ANSWER</span>${countdown()}</div><div class="prompt">${escapeHtml(state.prompt)}</div><p class="hint">Everyone will see your name next to your answer. Keep it punchy.</p>${mine ? `<div class="submitted"><span>✓</span> Your answer is locked in. Watch the room fill up.</div>` : `<form id="answer"><textarea name="text" maxlength="140" placeholder="Type your terrible idea…" autofocus required></textarea><div class="form-foot"><span>140 characters max</span><button class="primary">Submit answer <span>→</span></button></div></form>`}<div class="progress-line"><span>${state.players.filter(p => p.submitted).length} of ${state.players.length} submitted</span><div><i style="width:${state.players.filter(p => p.submitted).length / state.players.length * 100}%"></i></div></div>`);
  document.getElementById('answer')?.addEventListener('submit', async e => { e.preventDefault(); const text = new FormData(e.target).get('text'); try { await request(`/api/rooms/${state.code}/answer`, {method:'POST', body:JSON.stringify({text})}); await refresh(); } catch (err) { alert(err.message); } });
}
function renderVoting() {
  const voted = state.me?.voteId; const choices = state.answers.filter(a => a.playerId !== state.me.id);
  baseGame('Pick the funniest.', `<div class="phase-meta"><span class="phase-tag">VOTE FOR ONE</span>${countdown()}</div><div class="prompt compact">${escapeHtml(state.prompt)}</div><p class="hint">Choose the answer that deserves to survive the PR meeting.</p><div class="answer-list">${choices.map(a => `<button class="answer-choice ${voted === a.id ? 'selected' : ''}" data-answer="${a.id}" ${voted ? 'disabled' : ''}><span class="answer-name"><span class="avatar tiny">${initials(a.name)}</span>${escapeHtml(a.name)}</span><span class="answer-text">${escapeHtml(a.text)}</span>${voted === a.id ? '<span class="check">✓</span>' : '<span class="vote-arrow">→</span>'}</button>`).join('')}</div>${voted ? '<div class="submitted"><span>✓</span> Vote locked. Waiting for the other goblins…</div>' : ''}`);
  document.querySelectorAll('[data-answer]').forEach(btn => btn.addEventListener('click', async () => { try { await request(`/api/rooms/${state.code}/vote`, {method:'POST', body:JSON.stringify({answerId:btn.dataset.answer})}); await refresh(); } catch (err) { alert(err.message); } }));
}
function renderResult(final) {
  const top = state.results?.ranked?.[0]; const winner = state.players.slice().sort((a,b)=>b.score-a.score)[0];
  baseGame(final ? 'The verdict is in.' : 'The goblins have spoken.', `<div class="winner-banner"><span class="winner-icon">🏆</span><div><div class="eyebrow">${final ? 'FINAL CHAMPION' : 'ROUND WINNER'}</div><h2>${escapeHtml(final ? winner?.name || 'Nobody' : top?.name || 'Nobody')}</h2>${top ? `<p>“${escapeHtml(top.text)}”</p>` : ''}</div></div><div class="results-list">${(state.results?.ranked || []).map((a, i) => `<div class="result-row"><span class="place">${i + 1}</span><span class="result-copy"><b>${escapeHtml(a.name)}</b><span>${escapeHtml(a.text)}</span></span><strong>${a.votes} ${a.votes === 1 ? 'vote' : 'votes'}</strong></div>`).join('')}</div>${state.results?.chaosBonus ? '<div class="bonus">✦ CHAOS BONUS +1</div>' : ''}${final ? `<div class="final-score">${state.players.slice().sort((a,b)=>b.score-a.score).map((p,i)=>`<div><span>#${i+1}</span><b>${escapeHtml(p.name)}</b><strong>${p.score}</strong></div>`).join('')}</div>` : state.me?.isHost ? '<button class="primary wide" id="next">Next round <span>→</span></button>' : '<div class="waiting"><span class="pulse"></span> Host is starting the next round…</div>'}`);
  document.getElementById('next')?.addEventListener('click', async () => { await request(`/api/rooms/${state.code}/next`, {method:'POST'}); await refresh(); });
}
renderHome();
if (session) { refresh(); startPolling(); }
setInterval(() => { if (state?.endsAt) document.querySelectorAll('.timer').forEach(el => { const seconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000)); el.textContent = `0:${String(seconds).padStart(2,'0')}`; }); }, 250);
