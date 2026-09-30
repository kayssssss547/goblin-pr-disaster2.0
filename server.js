const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();

const MODES = {
  pr: { name: 'Goblin PR Disaster', blurb: 'Write the worst answer. Vote for the funniest.' },
  doodle: { name: 'Doodle Disaster', blurb: 'Draw something cursed. Vote for the best doodle.' },
  bluff: { name: 'Goblin Bluff', blurb: 'One truth. A room full of lies. Find the real answer.' },
  trivia: { name: 'Trivia Brawl', blurb: 'Answer fast. Outsmart the other goblins.' }
};
const PR_PROMPTS = [
  'The company mascot has been arrested. Write the apology.', 'Invent a product nobody asked for, but everyone will somehow buy.',
  'Complete this goblin motivational poster: “Believe in yourself, unless…”', 'The CEO accidentally livestreamed the staff meeting. Explain what viewers saw.',
  'Name the worst possible flavor for an energy drink.', 'Write the warning label for a suspiciously cheerful button.',
  'The office has hired a dragon as an intern. What is its first assignment?', 'Create a slogan for a startup whose only employee is a raccoon.',
  'The company party is ruined by one tiny mistake. What happened?', 'Pitch a completely unreasonable new company policy.'
];
const DOODLE_PROMPTS = ['A goblin trying to look normal at a job interview.', 'The world’s least useful superhero.', 'A dragon’s embarrassing secret.', 'A raccoon running a luxury hotel.', 'A snack that should never have been invented.', 'The CEO’s escape plan.'];
const BLUFF_PROMPTS = [
  { q: 'What is the official name for a group of flamingos?', a: 'A flamboyance' }, { q: 'What was the original purpose of bubble wrap?', a: 'Textured wallpaper' },
  { q: 'What is the only mammal capable of true flight?', a: 'A bat' }, { q: 'What do sea otters sometimes hold while sleeping?', a: 'Hands' },
  { q: 'What is a baby goat called?', a: 'A kid' }, { q: 'Which fruit floats because it is about 25% air?', a: 'An apple' }
];
const TRIVIA = [
  { q: 'Which animal has fingerprints so similar to humans that they can confuse investigators?', options: ['Koala', 'Penguin', 'Llama', 'Octopus'], correct: 0 },
  { q: 'What is the only food that never spoils?', options: ['Rice', 'Honey', 'Cheese', 'Chocolate'], correct: 1 },
  { q: 'How many hearts does an octopus have?', options: ['One', 'Two', 'Three', 'Eight'], correct: 2 },
  { q: 'Which planet has a day longer than its year?', options: ['Mars', 'Venus', 'Jupiter', 'Neptune'], correct: 1 },
  { q: 'What color is a flamingo before it eats its pink-making food?', options: ['Blue', 'White', 'Green', 'Purple'], correct: 1 },
  { q: 'What is the tiny dot over a lowercase i or j called?', options: ['A tittle', 'A nib', 'A serif', 'A fleck'], correct: 0 }
];

function json(res, status, body) { const out = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) }); res.end(out); }
function id() { return crypto.randomBytes(8).toString('hex'); }
function code() { let value; do value = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(value)); return value; }
function broadcast(room) { room.version++; }
function clearRoomTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function setRoomTimer(room, ms, fn) { clearRoomTimer(room); room.endsAt = Date.now() + ms; room.timer = setTimeout(fn, ms); }
function modeInfo(room) { return { id: room.gameMode, ...MODES[room.gameMode] }; }
function sanitizeRoom(room, token) {
  const me = room.players.find(p => p.token === token);
  return {
    code: room.code, phase: room.phase, round: room.round, totalRounds: room.totalRounds, prompt: room.prompt, endsAt: room.endsAt,
    gameMode: room.gameMode, mode: modeInfo(room), selectedMode: room.selectedMode,
    modeOptions: Object.entries(MODES).map(([id, value]) => ({ id, ...value })), doodleDuration: room.doodleDuration, timerVotes: room.timerVotes,
    triviaOptions: room.trivia?.options || null,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.token === room.hostToken, submitted: !!p.answer, voted: !!p.vote, answeredTrivia: p.triviaAnswer !== null })),
    answers: room.answers.map(a => ({ id: a.id, playerId: a.playerId, name: a.name, text: a.text, image: a.image, votes: room.phase === 'roundResult' || room.phase === 'gameOver' ? a.votes : undefined })),
    results: room.results,
    me: me ? { id: me.id, name: me.name, isHost: me.token === room.hostToken, answerId: me.answer?.id || null, voteId: me.vote || null, timerVote: me.timerVote || null, triviaAnswer: me.triviaAnswer, isTruth: room.truthPlayerId === me.id, truthAnswer: room.truthAnswer || null } : null
  };
}
function roomAndPlayer(codeValue, token) { const room = rooms.get(String(codeValue || '').toUpperCase()); if (!room) return { error: 'Room not found.' }; const player = room.players.find(p => p.token === token); if (!player) return { error: 'Player session not found.' }; return { room, player }; }

function beginAnswerRound(room, mode) {
  room.gameMode = mode; room.prompt = mode === 'doodle' ? DOODLE_PROMPTS[(room.round - 1) % DOODLE_PROMPTS.length] : mode === 'bluff' ? BLUFF_PROMPTS[(room.round - 1) % BLUFF_PROMPTS.length].q : PR_PROMPTS[(room.round - 1) % PR_PROMPTS.length];
  room.answers = []; room.results = null; room.trivia = null; room.truthPlayerId = null; room.truthAnswer = null; room.doodleDuration = null;
  room.players.forEach(p => { p.answer = null; p.vote = null; p.timerVote = null; p.triviaAnswer = null; p.triviaAt = null; });
  if (mode === 'doodle') { room.phase = 'timerVote'; room.prompt = DOODLE_PROMPTS[(room.round - 1) % DOODLE_PROMPTS.length]; setRoomTimer(room, 15000, () => finishTimerVote(room)); }
  else if (mode === 'trivia') { room.phase = 'trivia'; room.trivia = TRIVIA[(room.round - 1) % TRIVIA.length]; room.prompt = room.trivia.q; setRoomTimer(room, 20000, () => finishTrivia(room)); }
  else { if (mode === 'bluff') { const truth = room.players[Math.floor(Math.random() * room.players.length)]; room.truthPlayerId = truth.id; room.truthAnswer = BLUFF_PROMPTS[(room.round - 1) % BLUFF_PROMPTS.length].a; } room.phase = 'answering'; setRoomTimer(room, 45000, () => endAnswering(room)); }
  broadcast(room);
}
function startRound(room, mode = room.selectedMode) { clearRoomTimer(room); room.round += 1; beginAnswerRound(room, mode); }
function finishTimerVote(room) {
  if (room.phase !== 'timerVote') return;
  const values = [60, 120, 180]; const counts = new Map(values.map(v => [v, 0])); room.players.forEach(p => { if (p.timerVote) counts.set(p.timerVote, counts.get(p.timerVote) + 1); });
  room.doodleDuration = values.sort((a, b) => counts.get(b) - counts.get(a) || b - a)[0]; room.phase = 'doodleDrawing'; room.prompt = DOODLE_PROMPTS[(room.round - 1) % DOODLE_PROMPTS.length]; setRoomTimer(room, room.doodleDuration * 1000, () => endAnswering(room)); broadcast(room);
}
function endAnswering(room) { if (room.phase !== 'answering' && room.phase !== 'doodleDrawing') return; room.phase = 'voting'; setRoomTimer(room, 30000, () => endVoting(room)); broadcast(room); }
function applyVoteScores(room, ranked) {
  const multiplier = room.round === room.totalRounds ? 2 : 1; if (ranked[0]) room.players.find(p => p.id === ranked[0].playerId).score += 3 * multiplier; if (ranked[1] && ranked[1].votes > 0 && ranked[1].votes < ranked[0].votes) room.players.find(p => p.id === ranked[1].playerId).score += 1 * multiplier;
  const eligible = room.players.filter(p => p.vote); const chaosBonus = eligible.length >= 2 && new Set(eligible.map(p => p.vote)).size === 1; if (chaosBonus) { const answer = room.answers.find(a => a.id === eligible[0].vote); if (answer) room.players.find(p => p.id === answer.playerId).score += 1 * multiplier; }
  return { multiplier, chaosBonus };
}
function endVoting(room) {
  if (room.phase !== 'voting') return; clearRoomTimer(room); const tallies = new Map(room.answers.map(a => [a.id, 0])); room.players.forEach(p => { if (p.vote && tallies.has(p.vote)) tallies.set(p.vote, tallies.get(p.vote) + 1); }); room.answers.forEach(a => { a.votes = tallies.get(a.id) || 0; });
  const ranked = [...room.answers].sort((a, b) => b.votes - a.votes); const bonuses = applyVoteScores(room, ranked); if (room.gameMode === 'bluff') { const truth = room.answers.find(a => a.playerId === room.truthPlayerId); room.players.forEach(p => { if (p.vote === truth?.id) p.score += 1; }); }
  room.results = { ranked: ranked.map(a => ({ id: a.id, playerId: a.playerId, name: a.name, text: a.text, image: a.image, votes: a.votes })), ...bonuses, gameMode: room.gameMode }; room.phase = room.round >= room.totalRounds ? 'gameOver' : 'roundResult'; room.endsAt = null; broadcast(room);
}
function finishTrivia(room) {
  if (room.phase !== 'trivia') return; clearRoomTimer(room); const correct = room.trivia.correct; const answered = room.players.filter(p => p.triviaAnswer !== null); const ranked = answered.filter(p => p.triviaAnswer === correct).sort((a, b) => a.triviaAt - b.triviaAt); const multiplier = room.round === room.totalRounds ? 2 : 1; ranked.forEach((p, i) => { p.score += (2 + (i === 0 ? 1 : 0)) * multiplier; });
  room.results = { trivia: true, correct, options: room.trivia.options, ranked: answered.map(p => ({ name: p.name, correct: p.triviaAnswer === correct, choice: p.triviaAnswer })), multiplier }; room.phase = room.round >= room.totalRounds ? 'gameOver' : 'roundResult'; room.endsAt = null; broadcast(room);
}
function readBody(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 2000000) req.destroy(); }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); if (parts[0] !== 'api') return false;
  try {
    if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) { const body = await readBody(req); const name = String(body.name || '').trim().slice(0, 18); if (!name) return json(res, 400, { error: 'Enter a name first.' }); const room = { code: code(), hostToken: id(), players: [], phase: 'lobby', round: 0, totalRounds: 5, prompt: '', endsAt: null, answers: [], results: null, version: 0, selectedMode: 'pr', gameMode: 'pr', timer: null, timerVotes: {} }; room.players.push({ id: id(), token: room.hostToken, name, score: 0, answer: null, vote: null, timerVote: null, triviaAnswer: null, triviaAt: null }); rooms.set(room.code, room); return json(res, 201, { code: room.code, token: room.hostToken }); }
    if (req.method === 'POST' && parts[1] === 'rooms' && parts[3] === 'join') { const body = await readBody(req); const room = rooms.get(String(parts[2]).toUpperCase()); const name = String(body.name || '').trim().slice(0, 18); if (!room) return json(res, 404, { error: 'Room not found.' }); if (room.phase !== 'lobby') return json(res, 400, { error: 'This game has already started.' }); if (!name) return json(res, 400, { error: 'Enter a name first.' }); if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return json(res, 400, { error: 'That name is already taken in this room.' }); if (room.players.length >= 8) return json(res, 400, { error: 'This room is full.' }); const token = id(); room.players.push({ id: id(), token, name, score: 0, answer: null, vote: null, timerVote: null, triviaAnswer: null, triviaAt: null }); broadcast(room); return json(res, 201, { code: room.code, token }); }
    if (parts[1] === 'rooms' && parts[2] && parts[3] === 'state') { const found = roomAndPlayer(parts[2], url.searchParams.get('token')); if (found.error) return json(res, 401, { error: found.error }); return json(res, 200, sanitizeRoom(found.room, url.searchParams.get('token'))); }
    const token = req.headers['x-player-token']; const found = roomAndPlayer(parts[2], token); if (found.error) return json(res, 401, { error: found.error }); const { room, player } = found;
    if (req.method === 'POST' && parts[3] === 'choose-mode') { if (player.token !== room.hostToken) return json(res, 403, { error: 'Only the host can choose the game.' }); const body = await readBody(req); if (!MODES[body.mode]) return json(res, 400, { error: 'Unknown game mode.' }); if (room.phase === 'lobby') room.selectedMode = body.mode; else if (room.phase === 'roundResult') { room.selectedMode = body.mode; startRound(room, body.mode); } else return json(res, 400, { error: 'Choose a game between rounds.' }); broadcast(room); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'start') { if (player.token !== room.hostToken) return json(res, 403, { error: 'Only the host can start the game.' }); if (room.players.length < 2) return json(res, 400, { error: 'Invite at least one more player.' }); startRound(room, room.selectedMode); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'timer-vote') { if (room.phase !== 'timerVote') return json(res, 400, { error: 'Time voting is closed.' }); const body = await readBody(req); const seconds = Number(body.seconds); if (![60, 120, 180].includes(seconds)) return json(res, 400, { error: 'Choose 1, 2, or 3 minutes.' }); player.timerVote = seconds; broadcast(room); if (room.players.every(p => p.timerVote)) finishTimerVote(room); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'answer') { if (!['answering', 'doodleDrawing'].includes(room.phase)) return json(res, 400, { error: 'Answering is closed.' }); const body = await readBody(req); const text = String(body.text || '').trim().slice(0, 140); const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null; if (room.gameMode === 'doodle' ? !image : !text) return json(res, 400, { error: room.gameMode === 'doodle' ? 'Draw something first.' : 'Write an answer first.' }); if (player.answer) return json(res, 400, { error: 'You already submitted an answer.' }); const answer = { id: id(), playerId: player.id, name: player.name, text, image, votes: 0 }; player.answer = answer; room.answers.push(answer); broadcast(room); if (room.players.every(p => p.answer)) endAnswering(room); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'trivia') { if (room.phase !== 'trivia') return json(res, 400, { error: 'Trivia is closed.' }); const body = await readBody(req); const choice = Number(body.choice); if (!Number.isInteger(choice) || choice < 0 || choice >= room.trivia.options.length) return json(res, 400, { error: 'Choose an answer.' }); if (player.triviaAnswer !== null) return json(res, 400, { error: 'You already answered.' }); player.triviaAnswer = choice; player.triviaAt = Date.now(); broadcast(room); if (room.players.every(p => p.triviaAnswer !== null)) finishTrivia(room); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'vote') { if (room.phase !== 'voting') return json(res, 400, { error: 'Voting is closed.' }); const body = await readBody(req); const answer = room.answers.find(a => a.id === body.answerId); if (!answer) return json(res, 400, { error: 'Answer not found.' }); if (answer.playerId === player.id) return json(res, 400, { error: 'You cannot vote for your own answer.' }); player.vote = answer.id; broadcast(room); if (room.players.every(p => p.vote || !p.answer)) endVoting(room); return json(res, 200, sanitizeRoom(room, token)); }
    if (req.method === 'POST' && parts[3] === 'next') { if (player.token !== room.hostToken) return json(res, 403, { error: 'Only the host can continue.' }); if (room.phase === 'roundResult') startRound(room, room.selectedMode); return json(res, 200, sanitizeRoom(room, token)); }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Request failed.' }); }
}

const server = http.createServer(async (req, res) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/')) return api(req, res, url); let file = url.pathname === '/' ? '/index.html' : url.pathname; file = path.normalize(file).replace(/^\.\.[/\\]/, ''); const filePath = path.join(PUBLIC, file); fs.readFile(filePath, (err, data) => { if (err) return json(res, 404, { error: 'Not found.' }); const ext = path.extname(filePath); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }; res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' }); res.end(data); }); });
server.listen(PORT, '0.0.0.0', () => console.log(`Goblin Party running at http://localhost:${PORT}`));
