const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

const PROMPTS = [
  'The company mascot has been arrested. Write the apology.',
  'Invent a product nobody asked for, but everyone will somehow buy.',
  'Complete this goblin motivational poster: “Believe in yourself, unless…”',
  'The CEO accidentally livestreamed the staff meeting. Explain what viewers saw.',
  'Name the worst possible flavor for an energy drink.',
  'Write the warning label for a suspiciously cheerful button.',
  'The office has hired a dragon as an intern. What is its first assignment?',
  'Create a slogan for a startup whose only employee is a raccoon.',
  'The company party is ruined by one tiny mistake. What happened?',
  'Pitch a completely unreasonable new company policy.'
];

function json(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
  res.end(out);
}

function code() {
  let value;
  do value = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(value));
  return value;
}

function id() { return crypto.randomBytes(8).toString('hex'); }

function sanitizeRoom(room, token) {
  const me = room.players.find(p => p.token === token);
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    prompt: room.prompt,
    endsAt: room.endsAt,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.token === room.hostToken, submitted: !!p.answer, voted: !!p.vote })),
    answers: room.answers.map(a => ({ id: a.id, playerId: a.playerId, name: a.name, text: a.text, votes: room.phase === 'roundResult' || room.phase === 'gameOver' ? a.votes : undefined })),
    results: room.results,
    me: me ? { id: me.id, name: me.name, isHost: me.token === room.hostToken, answerId: me.answer?.id || null, voteId: me.vote || null } : null
  };
}

function roomAndPlayer(req, codeValue, token) {
  const room = rooms.get(String(codeValue || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = room.players.find(p => p.token === token);
  if (!player) return { error: 'Player session not found.' };
  return { room, player };
}

function broadcast(room) { room.version++; }

function endAnswering(room) {
  if (room.phase !== 'answering') return;
  room.phase = 'voting';
  room.endsAt = Date.now() + 30000;
  broadcast(room);
  room.timer = setTimeout(() => endVoting(room), 30000);
}

function endVoting(room) {
  if (room.phase !== 'voting') return;
  const tallies = new Map(room.answers.map(a => [a.id, 0]));
  room.players.forEach(p => { if (p.vote && tallies.has(p.vote)) tallies.set(p.vote, tallies.get(p.vote) + 1); });
  room.answers.forEach(a => { a.votes = tallies.get(a.id) || 0; });
  const ranked = [...room.answers].sort((a, b) => b.votes - a.votes);
  const multiplier = room.round === room.totalRounds ? 2 : 1;
  if (ranked[0]) room.players.find(p => p.id === ranked[0].playerId).score += 3 * multiplier;
  if (ranked[1] && ranked[1].votes > 0 && ranked[1].votes < ranked[0].votes) room.players.find(p => p.id === ranked[1].playerId).score += 1 * multiplier;
  const eligible = room.players.filter(p => p.vote);
  if (eligible.length >= 2 && new Set(eligible.map(p => p.vote)).size === 1) {
    const winner = room.answers.find(a => a.id === eligible[0].vote);
    if (winner) room.players.find(p => p.id === winner.playerId).score += 1 * multiplier;
  }
  room.results = { ranked: ranked.map(a => ({ id: a.id, name: a.name, text: a.text, votes: a.votes })), multiplier, chaosBonus: eligible.length >= 2 && new Set(eligible.map(p => p.vote)).size === 1 };
  room.phase = room.round >= room.totalRounds ? 'gameOver' : 'roundResult';
  room.endsAt = null;
  broadcast(room);
}

function startRound(room) {
  room.phase = 'answering';
  room.round += 1;
  room.prompt = PROMPTS[(room.round - 1) % PROMPTS.length];
  room.answers = [];
  room.results = null;
  room.players.forEach(p => { p.answer = null; p.vote = null; });
  room.endsAt = Date.now() + 45000;
  broadcast(room);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endAnswering(room), 45000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return false;
  try {
    if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 18);
      if (!name) return json(res, 400, { error: 'Enter a name first.' });
      const room = { code: code(), hostToken: id(), players: [], phase: 'lobby', round: 0, totalRounds: 5, prompt: '', endsAt: null, answers: [], results: null, version: 0 };
      room.players.push({ id: id(), token: room.hostToken, name, score: 0, answer: null, vote: null });
      rooms.set(room.code, room);
      return json(res, 201, { code: room.code, token: room.hostToken });
    }
    if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'join') {
      const body = await readBody(req);
      const room = rooms.get(String(parts[2]).toUpperCase());
      const name = String(body.name || '').trim().slice(0, 18);
      if (!room) return json(res, 404, { error: 'Room not found.' });
      if (room.phase !== 'lobby') return json(res, 400, { error: 'This game has already started.' });
      if (!name) return json(res, 400, { error: 'Enter a name first.' });
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return json(res, 400, { error: 'That name is already taken in this room.' });
      if (room.players.length >= 8) return json(res, 400, { error: 'This room is full.' });
      const token = id();
      room.players.push({ id: id(), token, name, score: 0, answer: null, vote: null });
      broadcast(room);
      return json(res, 201, { code: room.code, token });
    }
    if (parts[1] === 'rooms' && parts[2] && parts[3] === 'state') {
      const token = url.searchParams.get('token');
      const found = roomAndPlayer(req, parts[2], token);
      if (found.error) return json(res, 401, { error: found.error });
      return json(res, 200, sanitizeRoom(found.room, token));
    }
    const token = req.headers['x-player-token'];
    const found = roomAndPlayer(req, parts[2], token);
    if (found.error) return json(res, 401, { error: found.error });
    const { room, player } = found;
    if (req.method === 'POST' && parts[3] === 'start') {
      if (player.token !== room.hostToken) return json(res, 403, { error: 'Only the host can start the game.' });
      if (room.players.length < 2) return json(res, 400, { error: 'Invite at least one more player.' });
      startRound(room); return json(res, 200, sanitizeRoom(room, token));
    }
    if (req.method === 'POST' && parts[3] === 'answer') {
      if (room.phase !== 'answering') return json(res, 400, { error: 'Answering is closed.' });
      const body = await readBody(req); const text = String(body.text || '').trim().slice(0, 140);
      if (!text) return json(res, 400, { error: 'Write an answer first.' });
      if (player.answer) return json(res, 400, { error: 'You already submitted an answer.' });
      const answer = { id: id(), playerId: player.id, name: player.name, text, votes: 0 };
      player.answer = answer; room.answers.push(answer); broadcast(room);
      if (room.players.every(p => p.answer)) endAnswering(room);
      return json(res, 200, sanitizeRoom(room, token));
    }
    if (req.method === 'POST' && parts[3] === 'vote') {
      if (room.phase !== 'voting') return json(res, 400, { error: 'Voting is closed.' });
      const body = await readBody(req); const answer = room.answers.find(a => a.id === body.answerId);
      if (!answer) return json(res, 400, { error: 'Answer not found.' });
      if (answer.playerId === player.id) return json(res, 400, { error: 'You cannot vote for your own answer.' });
      player.vote = answer.id; broadcast(room);
      if (room.players.every(p => p.vote || !p.answer)) endVoting(room);
      return json(res, 200, sanitizeRoom(room, token));
    }
    if (req.method === 'POST' && parts[3] === 'next') {
      if (player.token !== room.hostToken) return json(res, 403, { error: 'Only the host can continue.' });
      if (room.phase === 'roundResult') startRound(room);
      return json(res, 200, sanitizeRoom(room, token));
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Request failed.' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^\.\.[/\\]/, '');
  const filePath = path.join(PUBLIC, file);
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found.' });
    const ext = path.extname(filePath); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Goblin PR Disaster running at http://localhost:${PORT}`));
