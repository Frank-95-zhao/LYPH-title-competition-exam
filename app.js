const STATE_KEY = 'lyphTitleCompetition_v3';
const LEGACY_KEY = 'doctorLawExam_v1';
const DAILY_SIZE = 50;
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

let bank = null;
let questionsById = new Map();
let state = null;
let pendingMulti = new Set();
let wrongFilter = 'all';
let touchStart = null;
let toastTimer = null;

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function emptyState() {
  return {version: 4, answered: 0, correct: 0, wrong: {}, seen: {}, moduleStats: {}, activeSession: null, migratedLegacy: false};
}

function loadState() {
  try {
    state = {...emptyState(), ...JSON.parse(localStorage.getItem(STATE_KEY) || 'null')};
  } catch {
    state = emptyState();
  }
  state.wrong ||= {};
  state.seen ||= {};
  state.moduleStats ||= {};
  if (!state.migratedLegacy) migrateLegacy();
}

function migrateLegacy() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
    if (legacy) {
      state.answered = Math.max(state.answered, Number(legacy.answered) || 0);
      state.correct = Math.max(state.correct, Number(legacy.correct) || 0);
      Object.entries(legacy.wrong || {}).forEach(([id, count]) => {
        const qid = `physician-curated-${String(id).padStart(3, '0')}`;
        state.wrong[qid] = Math.max(state.wrong[qid] || 0, Number(count) || 1);
      });
      Object.keys(legacy.todayAnswers || {}).forEach(id => {
        state.seen[`physician-curated-${String(id).padStart(3, '0')}`] = true;
      });
    }
  } catch {}
  state.migratedLegacy = true;
  persist();
}

function persist() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function moduleById(id) {
  return bank.modules.find(module => module.id === id);
}

function moduleQuestions(id) {
  return bank.questions.filter(question => question.moduleId === id);
}

function moduleStat(id) {
  return state.moduleStats[id] || {answered: 0, correct: 0};
}

function currentSession() {
  return state.activeSession;
}

function currentQuestion() {
  const session = currentSession();
  return session ? questionsById.get(session.questionIds[session.pos]) : null;
}

function seededShuffle(values, seed) {
  const result = [...values];
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const random = () => {
    hash += 0x6D2B79F5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function prioritizedQuestions(source, seed, limit = null) {
  const wrong = seededShuffle(source.filter(q => state.wrong[q.id]), `${seed}-wrong`)
    .sort((a, b) => (state.wrong[b.id] || 0) - (state.wrong[a.id] || 0));
  const fresh = seededShuffle(source.filter(q => !state.seen[q.id] && !state.wrong[q.id]), `${seed}-fresh`);
  const review = seededShuffle(source.filter(q => state.seen[q.id] && !state.wrong[q.id]), `${seed}-review`);
  const selected = [...wrong, ...fresh, ...review];
  return limit ? selected.slice(0, limit) : selected;
}

function createSession(moduleId, mode = 'module') {
  let selected = [];
  if (mode === 'module') {
    selected = moduleQuestions(moduleId);
  } else if (mode === 'daily') {
    selected = prioritizedQuestions(bank.questions, `${new Date().toISOString().slice(0, 10)}-daily`, DAILY_SIZE);
  } else if (mode === 'wrong') {
    const source = bank.questions.filter(q => state.wrong[q.id] && (moduleId === 'all' || q.moduleId === moduleId));
    selected = prioritizedQuestions(source, `${new Date().toISOString().slice(0, 10)}-${moduleId}-wrong`);
  }
  if (!selected.length) {
    showToast(mode === 'wrong' ? '目前没有可复习的错题' : '该题库暂无题目');
    return false;
  }
  state.activeSession = {
    moduleId: mode === 'module' ? moduleId : 'mixed',
    mode,
    questionIds: selected.map(q => q.id),
    pos: 0,
    answers: {},
    drafts: {},
    startedAt: new Date().toISOString(),
  };
  pendingMulti.clear();
  persist();
  showView('quiz');
  return true;
}

function resumeSession() {
  if (state.activeSession) showView('quiz');
}

function renderHome() {
  $('totalAnswered').textContent = state.answered;
  $('homeRate').textContent = state.answered ? `${Math.round(state.correct / state.answered * 100)}%` : '—';
  $('homeWrong').textContent = Object.keys(state.wrong).length;
  $('bankTotal').textContent = `${bank.questions.length} 题`;
  $('headerSub').textContent = `10 类法规与制度 · ${bank.questions.length} 道质检题 · 单选 + 多选`;
  const session = state.activeSession;
  $('resumeBox').classList.toggle('hidden', !session);
  if (session) {
    const current = questionsById.get(session.questionIds[session.pos]);
    $('resumeTitle').textContent = session.mode === 'module' ? (moduleById(session.moduleId)?.name || '分类练习') : session.mode === 'daily' ? '今日 50 题' : '错题专项';
    $('resumeMeta').textContent = `${current ? moduleById(current.moduleId)?.name + ' · ' : ''}第 ${session.pos + 1} / ${session.questionIds.length} 题`;
  }
  $('moduleGrid').innerHTML = bank.modules.map(module => {
    const seen = moduleQuestions(module.id).filter(q => state.seen[q.id]).length;
    const progress = module.questionCount ? Math.round(seen / module.questionCount * 100) : 0;
    return `<button class="module-card" style="--accent:${module.accent}" data-module="${module.id}">
      <span class="module-order">${String(module.order).padStart(2, '0')}</span>
      <h3>${module.name}</h3>
      <div class="module-meta">${module.questionCount} 题 · ${module.singleCount} 单选 · ${module.multipleCount} 多选</div>
      <div class="module-bottom"><b>进入全部题目</b><span class="mini-progress"><i style="width:${progress}%"></i></span></div>
    </button>`;
  }).join('');
}

function renderQuestion() {
  const session = currentSession();
  const question = currentQuestion();
  if (!session || !question) {
    showView('home');
    return;
  }
  const module = moduleById(question.moduleId);
  const saved = session.answers[question.id];
  const answered = Boolean(saved?.submitted);
  session.drafts ||= {};
  pendingMulti = new Set(answered ? saved.selected : (session.drafts[question.id] || []));

  $('quizModule').textContent = session.mode === 'module' ? module.name : `${session.mode === 'daily' ? '今日练习' : '错题复习'} · ${module.name}`;
  $('quizCounter').textContent = `第 ${session.pos + 1} / ${session.questionIds.length} 题`;
  $('quizProgress').style.width = `${(session.pos + 1) / session.questionIds.length * 100}%`;
  $('typeBadge').textContent = question.type === 'multiple' ? '多选' : '单选';
  $('questionRef').textContent = question.qualityFamily || question.topic || '模拟练习';
  $('questionText').textContent = question.question;
  $('multiHint').classList.toggle('hidden', question.type !== 'multiple');
  $('optionList').innerHTML = question.options.map((option, index) => {
    const selected = answered ? saved.selected.includes(index) : pendingMulti.has(index);
    const correct = answered && question.answers.includes(index);
    const wrong = answered && selected && !correct;
    const classes = ['option', selected ? 'selected' : '', correct ? 'correct' : '', wrong ? 'wrong' : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" data-option="${index}" ${answered ? 'disabled' : ''}><span class="letter">${letters[index]}.</span><span>${escapeHtml(option)}</span></button>`;
  }).join('');
  $('submitMultiple').classList.toggle('hidden', question.type !== 'multiple' || answered);
  $('submitMultiple').disabled = pendingMulti.size === 0;
  $('explanation').classList.toggle('hidden', !answered);
  if (answered) {
    $('explanation').className = `explanation ${saved.correct ? 'good' : 'bad'}`;
    $('explanation').innerHTML = `<b>${saved.correct ? '回答正确' : '回答错误'} · 正确答案 ${question.answers.map(index => letters[index]).join('、')}</b><br>${escapeHtml(question.explanation)}`;
  }
  $('prevButton').disabled = session.pos === 0;
  $('nextButton').disabled = session.pos === session.questionIds.length - 1;
  renderQuestionNavigator();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function renderQuestionNavigator() {
  const session = currentSession();
  if (!session) return;
  $('jumpInput').max = session.questionIds.length;
  $('jumpInput').placeholder = `1-${session.questionIds.length}`;
  $('questionGrid').innerHTML = session.questionIds.map((id, index) => {
    const answer = session.answers[id];
    const classes = ['number-cell', index === session.pos ? 'current' : '', answer?.submitted ? (answer.correct ? 'done-correct' : 'done-wrong') : ''].filter(Boolean).join(' ');
    return `<button class="${classes}" data-jump-index="${index}">${index + 1}</button>`;
  }).join('');
}

function toggleNavigator(show = null) {
  const navigator = $('questionNavigator');
  navigator.classList.toggle('hidden', show === null ? !navigator.classList.contains('hidden') : !show);
  if (!navigator.classList.contains('hidden')) {
    requestAnimationFrame(() => document.querySelector('.number-cell.current')?.scrollIntoView({block: 'center'}));
  }
}

function toggleOption(index) {
  const question = currentQuestion();
  const session = currentSession();
  if (!question || session.answers[question.id]?.submitted) return;
  if (question.type === 'single') {
    submitAnswer([index]);
    return;
  }
  pendingMulti.has(index) ? pendingMulti.delete(index) : pendingMulti.add(index);
  session.drafts ||= {};
  session.drafts[question.id] = [...pendingMulti];
  persist();
  document.querySelector(`[data-option="${index}"]`)?.classList.toggle('selected', pendingMulti.has(index));
  $('submitMultiple').disabled = pendingMulti.size === 0;
}

function arraysEqual(first, second) {
  const a = [...first].sort((x, y) => x - y);
  const b = [...second].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function submitAnswer(selected) {
  const session = currentSession();
  const question = currentQuestion();
  if (!session || !question || session.answers[question.id]?.submitted) return;
  selected = [...new Set(selected)].sort((a, b) => a - b);
  const correct = arraysEqual(selected, question.answers);
  session.answers[question.id] = {selected, correct, submitted: true, at: new Date().toISOString()};
  if (session.drafts) delete session.drafts[question.id];
  state.seen[question.id] = true;
  state.answered += 1;
  if (correct) state.correct += 1;
  const stats = state.moduleStats[question.moduleId] || {answered: 0, correct: 0};
  stats.answered += 1;
  if (correct) stats.correct += 1;
  state.moduleStats[question.moduleId] = stats;
  if (correct) {
    if (state.wrong[question.id]) {
      state.wrong[question.id] -= 1;
      if (state.wrong[question.id] <= 0) delete state.wrong[question.id];
    }
  } else {
    state.wrong[question.id] = (state.wrong[question.id] || 0) + 1;
  }
  persist();
  renderQuestion();
}

function moveQuestion(delta) {
  const session = currentSession();
  if (!session) return;
  const next = session.pos + delta;
  if (next < 0) {
    showToast('已经是第一题');
    return;
  }
  if (next >= session.questionIds.length) {
    showToast('已经是最后一题');
    return;
  }
  session.pos = next;
  persist();
  renderQuestion();
}

function jumpToQuestion(index) {
  const session = currentSession();
  if (!session || index < 0 || index >= session.questionIds.length) {
    showToast('请输入有效题号');
    return;
  }
  session.pos = index;
  persist();
  toggleNavigator(false);
  renderQuestion();
}

function renderWrong() {
  const all = bank.questions.filter(q => state.wrong[q.id]);
  const used = new Set(all.map(q => q.moduleId));
  $('wrongFilters').innerHTML = [{id: 'all', name: '全部'}, ...bank.modules.filter(m => used.has(m.id))]
    .map(item => `<button class="${wrongFilter === item.id ? 'active' : ''}" data-wrong-filter="${item.id}">${item.name}</button>`).join('');
  const filtered = all.filter(q => wrongFilter === 'all' || q.moduleId === wrongFilter)
    .sort((a, b) => state.wrong[b.id] - state.wrong[a.id]);
  $('wrongList').innerHTML = filtered.length ? filtered.map(question => `<div class="wrong-item"><div class="wrong-head"><span class="tag">${moduleById(question.moduleId).name}</span><b>错 ${state.wrong[question.id]} 次</b></div><p>${escapeHtml(question.question)}</p><small>${question.type === 'multiple' ? '多选' : '单选'}</small></div>`).join('') : '<div class="empty">暂无错题，继续保持。</div>';
}

function renderStats() {
  $('statsAnswered').textContent = state.answered;
  $('statsCorrect').textContent = state.correct;
  $('statsRate').textContent = state.answered ? `${Math.round(state.correct / state.answered * 100)}%` : '—';
  $('moduleStats').innerHTML = bank.modules.map(module => {
    const stats = moduleStat(module.id);
    const rate = stats.answered ? `${Math.round(stats.correct / stats.answered * 100)}%` : '—';
    const seen = moduleQuestions(module.id).filter(q => state.seen[q.id]).length;
    return `<div class="stat-row"><div><b>${module.order}. ${module.name}</b><small>已覆盖 ${seen} / ${module.questionCount} 题</small></div><strong>${rate}</strong></div>`;
  }).join('');
}

function showView(name) {
  if (name === 'quiz' && !state.activeSession) {
    showToast('请先从题库选择一个类别');
    name = 'home';
  }
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== `${name}View`));
  document.querySelectorAll('.bottom-nav button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  document.querySelector('.bottom-nav').classList.toggle('hidden', name === 'plan');
  toggleNavigator(false);
  if (name === 'home') renderHome();
  if (name === 'quiz') renderQuestion();
  if (name === 'wrong') renderWrong();
  if (name === 'stats') renderStats();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1800);
}

function escapeHtml(value) {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstall() {
  $('installTip').classList.toggle('show', !isStandalone());
  $('networkState').textContent = navigator.onLine ? '已联网 · 离线资源将自动更新' : '当前离线 · 仍可继续刷题';
}

function bindEvents() {
  document.addEventListener('click', event => {
    const module = event.target.closest('[data-module]');
    if (module) {
      createSession(module.dataset.module);
      return;
    }
    const option = event.target.closest('[data-option]');
    if (option) {
      toggleOption(Number(option.dataset.option));
      return;
    }
    const jump = event.target.closest('[data-jump-index]');
    if (jump) {
      jumpToQuestion(Number(jump.dataset.jumpIndex));
      return;
    }
    const filter = event.target.closest('[data-wrong-filter]');
    if (filter) {
      wrongFilter = filter.dataset.wrongFilter;
      renderWrong();
      return;
    }
    const nav = event.target.closest('[data-view]');
    if (nav) {
      showView(nav.dataset.view);
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'show-plan') showView('plan');
    if (action === 'show-home' || action === 'pause') showView('home');
    if (action === 'resume') resumeSession();
    if (action === 'previous') moveQuestion(-1);
    if (action === 'next') moveQuestion(1);
    if (action === 'show-jump') toggleNavigator(true);
    if (action === 'close-jump') toggleNavigator(false);
    if (action === 'jump-go') jumpToQuestion(Number($('jumpInput').value) - 1);
    if (action === 'submit-multiple') submitAnswer([...pendingMulti]);
    if (action === 'practice-wrong') createSession(wrongFilter, 'wrong');
    if (action === 'start-daily') createSession('all', 'daily');
    if (action === 'reset' && confirm('确定清空当前浏览器里的全部学习记录吗？')) {
      localStorage.removeItem(STATE_KEY);
      location.reload();
    }
  });
  $('jumpInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') jumpToQuestion(Number(event.target.value) - 1);
  });
  const card = $('questionCard');
  card.addEventListener('touchstart', event => {
    const touch = event.changedTouches[0];
    touchStart = {x: touch.clientX, y: touch.clientY, time: Date.now()};
  }, {passive: true});
  card.addEventListener('touchend', event => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    const elapsed = Date.now() - touchStart.time;
    touchStart = null;
    if (elapsed < 700 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.25) moveQuestion(dx > 0 ? -1 : 1);
  }, {passive: true});
  addEventListener('online', updateInstall);
  addEventListener('offline', updateInstall);
}

function upgradeActiveSession() {
  const session = state.activeSession;
  if (!session) return;
  session.answers ||= {};
  session.drafts ||= {};
  session.questionIds = session.questionIds.filter(id => questionsById.has(id));
  if (session.mode === 'module' && moduleById(session.moduleId)) {
    const currentId = session.questionIds[session.pos];
    session.questionIds = moduleQuestions(session.moduleId).map(q => q.id);
    session.pos = Math.max(0, session.questionIds.indexOf(currentId));
  }
  if (!session.questionIds.length) state.activeSession = null;
  persist();
}

async function init() {
  try {
    const response = await fetch('./data/questions.json', {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = await response.json();
    const parts = await Promise.all(meta.modules.map(async module => {
      const result = await fetch(meta.questionFiles[module.id], {cache: 'no-cache'});
      if (!result.ok) throw new Error(`${meta.questionFiles[module.id]}: HTTP ${result.status}`);
      return result.json();
    }));
    bank = {...meta, questions: parts.flatMap(part => part.questions)};
    questionsById = new Map(bank.questions.map(question => [question.id, question]));
    loadState();
    upgradeActiveSession();
    bindEvents();
    renderHome();
    updateInstall();
    $('loading').classList.add('hidden');
    $('app').classList.remove('hidden');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      const register = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
      document.readyState === 'complete' ? register() : addEventListener('load', register, {once: true});
    }
  } catch (error) {
    $('loading').innerHTML = '<b>题库加载失败，请联网刷新后重试。</b>';
    console.error(error);
  }
}

init();
