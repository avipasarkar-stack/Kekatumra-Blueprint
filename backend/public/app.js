const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

const apiMessages = {
  unauthorized: 'या सुविधेसाठी आधी लॉगिन करा.',
  forbidden: 'या कृतीसाठी प्रशासकाचा अधिकार आवश्यक आहे.',
  invalid_credentials: 'वापरकर्तानाव किंवा पासवर्ड चुकीचा आहे.',
  account_locked: 'अनेक चुकीच्या प्रयत्नांमुळे खाते तात्पुरते लॉक झाले आहे. नंतर पुन्हा प्रयत्न करा.',
  rate_limited: 'खूप प्रयत्न झाले आहेत. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.',
  invalid_phone: 'मोबाईल क्रमांक १० अंकी असावा.',
  required: 'कृपया आवश्यक माहिती तपासा.',
  worker_not_found: 'मंजूर कामगार सापडला नाही. यादी अद्ययावत करून पुन्हा प्रयत्न करा.',
  duplicate_family: 'ही कुटुंब नोंद आधीपासून आहे. यादीतून ती नोंद उघडून अद्ययावत करा.',
  conflict: 'ही नोंद दुसऱ्या कोणीतरी बदलली आहे. ती पुन्हा उघडून बदल तपासा.',
  needs_confirmation: 'समान माहितीसाठी पुष्टी आवश्यक आहे.'
};

async function apiRequest(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('सर्व्हरशी संपर्क होत नाही. कृपया backend सुरू आहे का ते तपासा.');
  }
  let data = null;
  try { data = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok) {
    const error = new Error(apiMessages[data?.error] || data?.message || 'सर्व्हरशी संपर्क साधता आला नाही.');
    error.status = response.status;
    error.code = data?.error || 'request_failed';
    error.data = data;
    if (response.status === 401 && path !== '/api/auth/me') {
      setTimeout(() => window.refreshSession?.(), 0);
    }
    throw error;
  }
  return data;
}
window.apiRequest = apiRequest;

const navButtons = document.querySelectorAll('[data-page]');
const pages = document.querySelectorAll('.page');
const mainNav = $('mainNav');
const menuToggle = $('menuToggle');
function showPage(pageId) {
  const target = $(pageId);
  if (!target || !target.classList.contains('page')) return;
  pages.forEach(page => page.classList.toggle('active', page === target));
  navButtons.forEach(button => button.classList.toggle('active', button.dataset.page === pageId));
  mainNav?.classList.remove('open');
  menuToggle?.setAttribute('aria-expanded', 'false');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pageId === 'skills') renderSkills();
  if (pageId === 'workers') loadWorkers();
  if (pageId === 'suggestions') loadSuggestions();
  if (pageId === 'admin' && window.currentUser?.role === 'admin') loadAdminQueue();
  if (pageId === 'survey' && window.currentUser && window.familySurvey) window.familySurvey.load();
}
window.showPage = showPage;
document.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const pageButton = target.closest('[data-page]');
  const gotoButton = target.closest('[data-goto]');
  if (pageButton) { event.preventDefault(); showPage(pageButton.dataset.page); return; }
  if (gotoButton) { event.preventDefault(); showPage(gotoButton.dataset.goto); }
});
menuToggle?.addEventListener('click', () => {
  const open = mainNav?.classList.toggle('open') || false;
  menuToggle.setAttribute('aria-expanded', String(open));
});

function setStatus(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}
function errorText(error) {
  return apiMessages[error?.code] || error?.message || 'अनपेक्षित त्रुटी. कृपया पुन्हा प्रयत्न करा.';
}

let publicWorkers = null;
let workerRequest = 0;
async function loadSuggestions() {
  const host = $('publicSuggestions');
  if (!host) return;
  host.innerHTML = '<p class="small-muted">सूचना लोड होत आहेत…</p>';
  try {
    const rows = await apiRequest('/api/suggestions');
    host.innerHTML = rows.length ? rows.map(item =>
      `<article class="public-profile"><b>${esc(item.category)}</b><p>${esc(item.text)}</p>${item.name ? `<small>सूचना देणारे: ${esc(item.name)}</small>` : ''}</article>`
    ).join('') : '<p class="small-muted">अद्याप सार्वजनिक करण्यासाठी मंजूर सूचना नाहीत.</p>';
  } catch (error) {
    host.textContent = `सूचना लोड करता आल्या नाहीत: ${errorText(error)}`;
  }
}

function workerMarkup(worker) {
  const rating = worker.ratingCount
    ? `★ ${esc(worker.ratingAvg)} (${esc(worker.ratingCount)} अभिप्राय)`
    : 'रेटिंग नाही';
  const phone = worker.phone
    ? `<p><a href="tel:${esc(worker.phone)}">संपर्क: ${esc(worker.phone)}</a></p>`
    : '';
  return `<article class="public-profile"><h3>${esc(worker.name)}</h3><b>${esc(worker.skill)}</b><p>अनुभव: ${esc(worker.experience)} वर्षे · ${esc(worker.availability)}</p><p>${esc(worker.description || '')}</p><p>सेवा क्षेत्र: ${esc(worker.area)}</p><p class="stars">${rating}</p>${phone}<button class="button button-light" data-goto="ratings">रेटिंग द्या</button></article>`;
}
function updateRatingOptions(workers) {
  const select = $('ratingWorker');
  if (!select) return;
  const value = select.value;
  select.innerHTML = '<option value="">मंजूर कामगार निवडा</option>' +
    workers.map(worker => `<option value="${esc(worker.id)}">${esc(worker.name)} — ${esc(worker.skill)}</option>`).join('');
  if (workers.some(worker => worker.id === value)) select.value = value;
}
function renderRatingSummary() {
  const host = $('workerRatingSummary');
  if (!host) return;
  host.innerHTML = publicWorkers.length
    ? publicWorkers.map(worker => {
      const average = worker.ratingCount ? `★ ${esc(worker.ratingAvg)}` : 'रेटिंग नाही';
      return `<p><b>${esc(worker.name)}</b> — ${esc(worker.skill)} · <span class="stars">${average}</span> (${esc(worker.ratingCount)} अभिप्राय)</p>`;
    }).join('')
    : '<p class="small-muted">मंजूर कामगार उपलब्ध नाहीत.</p>';
}
async function loadWorkers(refresh = false) {
  const host = $('publicWorkerDirectory');
  if (!host) return;
  const request = ++workerRequest;
  const query = new URLSearchParams();
  const search = $('workerSearch')?.value.trim();
  if (search) query.set('search', search);
  host.innerHTML = '<p class="small-muted">कामगारांची यादी लोड होत आहे…</p>';
  try {
    const allWorkers = publicWorkers && !refresh ? publicWorkers : await apiRequest('/api/workers');
    const queryString = query.toString();
    const workers = queryString ? await apiRequest(`/api/workers?${queryString}`) : allWorkers;
    if (request !== workerRequest) return;
    publicWorkers = allWorkers;
    host.innerHTML = workers.length
      ? workers.map(workerMarkup).join('')
      : '<p class="small-muted">शोधाशी जुळणारे मंजूर कामगार सापडले नाहीत.</p>';
    updateRatingOptions(allWorkers);
    renderRatingSummary();
  } catch (error) {
    if (request === workerRequest) host.textContent = `कामगारांची यादी लोड करता आली नाही: ${errorText(error)}`;
  }
}

const skillSearch = $('skillSearch');
const skillCategory = $('skillCategory');
const skillResults = $('skillResults');
let skillRequest = 0;
async function renderSkills() {
  if (!skillResults) return;
  const request = ++skillRequest;
  const query = new URLSearchParams({ contact: '1' });
  const search = skillSearch?.value.trim();
  const skill = skillCategory?.value;
  if (search) query.set('search', search);
  if (skill) query.set('skill', skill);
  skillResults.innerHTML = '<p class="small-muted">सेवा शोधत आहे…</p>';
  try {
    const workers = await apiRequest(`/api/workers?${query}`);
    if (request !== skillRequest) return;
    skillResults.innerHTML = workers.length
      ? workers.map(workerMarkup).join('')
      : '<article class="panel"><h3>जुळणारे मंजूर प्रोफाइल नाही</h3><p>श्रेणी किंवा शब्द बदलून पाहा. तपासणी व मंजुरीनंतर नोंदणी येथे दिसेल.</p><button class="button button-primary" data-goto="workers">नोंदणी करा</button></article>';
  } catch (error) {
    if (request === skillRequest) skillResults.textContent = `सेवा शोधता आली नाही: ${errorText(error)}`;
  }
}
$('skillSearchBtn')?.addEventListener('click', renderSkills);
skillSearch?.addEventListener('input', renderSkills);
skillSearch?.addEventListener('keydown', event => { if (event.key === 'Enter') renderSkills(); });
skillCategory?.addEventListener('change', renderSkills);

$('workerSearch')?.addEventListener('input', () => {
  clearTimeout(window.workerSearchTimer);
  window.workerSearchTimer = setTimeout(loadWorkers, 180);
});

$('villageSuggestionForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const consent = $('suggestionConsent').checked;
  setStatus('suggestionStatus', 'सूचना पाठवत आहे…');
  try {
    const result = await apiRequest('/api/suggestions', {
      method: 'POST',
      body: {
        category: $('suggestionCategory').value,
        text: $('suggestionText').value.trim(),
        consent,
        name: consent ? $('suggestionName').value.trim() : '',
        phone: consent ? $('suggestionContact').value.trim() : ''
      }
    });
    form.reset();
    setStatus('suggestionStatus', result.message || 'सूचना यशस्वीरीत्या मिळाली. मंजुरीनंतर ती सार्वजनिक होईल.');
    await loadSuggestions();
  } catch (error) {
    setStatus('suggestionStatus', `सूचना पाठवता आली नाही: ${errorText(error)}`);
  }
});

$('workerRegistrationForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const selectedSkill = $('workerSkill').value;
  setStatus('workerStatus', 'नोंदणी पाठवत आहे…');
  try {
    const result = await apiRequest('/api/workers', {
      method: 'POST',
      body: {
        name: $('workerName').value.trim(),
        skill: selectedSkill === 'इतर' ? $('workerOtherSkill').value.trim() : selectedSkill,
        experience: Number($('workerExperience').value),
        availability: $('workerAvailability').value,
        area: $('workerArea').value.trim(),
        description: $('workerDescription').value.trim(),
        phone: $('workerPhone').value.trim(),
        contactConsent: $('workerPublicContact').checked
      }
    });
    form.reset();
    $('workerArea').value = 'केकत उमरा';
    setStatus('workerStatus', result.message || 'नोंदणी मिळाली. प्रशासकीय मंजुरीनंतरच ती सार्वजनिक होईल.');
  } catch (error) {
    setStatus('workerStatus', `नोंदणी पाठवता आली नाही: ${errorText(error)}`);
  }
});

$('workerRatingForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const stars = Number(document.querySelector('input[name="workerStars"]:checked')?.value || 0);
  setStatus('ratingStatus', 'रेटिंग पाठवत आहे…');
  try {
    const result = await apiRequest('/api/ratings', {
      method: 'POST',
      body: {
        workerId: $('ratingWorker').value,
        stars,
        feedback: $('ratingFeedback').value.trim()
      }
    });
    form.reset();
    setStatus('ratingStatus', result.message || 'रेटिंग मिळाली. तपासणीनंतरच सरासरीत मोजली जाईल.');
  } catch (error) {
    setStatus('ratingStatus', `रेटिंग पाठवता आली नाही: ${errorText(error)}`);
  }
});

function renderAdminQueue(data) {
  const host = $('stage23PendingQueue');
  if (!host) return;
  const groups = [
    ['सूचना', 'suggestions', data.suggestions || []],
    ['कामगार', 'workers', data.workers || []],
    ['रेटिंग', 'ratings', data.ratings || []]
  ];
  const entries = [];
  for (const [label, kind, rows] of groups) {
    for (const item of rows) {
      const detail = kind === 'suggestions'
        ? `${esc(item.category)} — ${esc(item.text)}${item.name ? `<br>नाव: ${esc(item.name)}` : ''}${item.phone ? `<br>मोबाईल: ${esc(item.phone)}` : ''}`
        : kind === 'workers'
          ? `${esc(item.name)} — ${esc(item.skill)}<br>अनुभव: ${esc(item.experience)} वर्षे · ${esc(item.availability)}<br>सेवा क्षेत्र: ${esc(item.area)}<br>मोबाईल: ${esc(item.phone)} · संपर्क संमती: ${item.contactConsent ? 'होय' : 'नाही'}<br>${esc(item.description || '')}`
          : `${esc(item.stars)} स्टार — ${esc(item.feedback || 'अभिप्राय नाही')}`;
      entries.push(`<article class="public-profile" style="margin:10px 0"><b>${label}</b><p>${detail}</p><button type="button" class="button button-primary" data-queue-action="approve" data-kind="${kind}" data-id="${esc(item.id)}">मंजूर करा</button> <button type="button" class="button button-light" data-queue-action="reject" data-kind="${kind}" data-id="${esc(item.id)}">नाकारून हटवा</button></article>`);
    }
  }
  host.innerHTML = entries.length ? entries.join('') : '<p class="small-muted">प्रलंबित नोंदी नाहीत.</p>';
}
async function loadAdminQueue() {
  if (window.currentUser?.role !== 'admin') return;
  const host = $('stage23PendingQueue');
  if (host) host.innerHTML = '<p class="small-muted">प्रलंबित नोंदी लोड होत आहेत…</p>';
  try {
    renderAdminQueue(await apiRequest('/api/admin/pending'));
  } catch (error) {
    if (host) host.textContent = `प्रलंबित नोंदी लोड करता आल्या नाहीत: ${errorText(error)}`;
    if (error.status === 401 || error.status === 403) await refreshSession();
  }
}
$('stage23PendingQueue')?.addEventListener('click', async event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('button[data-queue-action]');
  if (!button || window.currentUser?.role !== 'admin') return;
  const { kind, id, queueAction } = button.dataset;
  if (queueAction === 'reject' && !confirm('ही प्रलंबित नोंद कायमची हटवायची आहे का?')) return;
  button.disabled = true;
  try {
    if (queueAction === 'approve') {
      await apiRequest(`/api/admin/queue/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} });
    } else {
      await apiRequest(`/api/admin/queue/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
    }
    await Promise.all([loadAdminQueue(), loadSuggestions(), loadWorkers(true)]);
    await renderSkills();
  } catch (error) {
    setStatus('adminSessionStatus', `कृती करता आली नाही: ${errorText(error)}`);
    button.disabled = false;
    if (error.status === 401 || error.status === 403) await refreshSession();
  }
});

function setLoginForm(form, user) {
  if (!form) return;
  const loggedIn = Boolean(user);
  form.querySelectorAll('label, input, button[type="submit"]').forEach(element => { element.hidden = loggedIn; });
  const logout = form.querySelector('button[type="button"]');
  if (logout) logout.hidden = !loggedIn;
}
function updateSessionUI(user) {
  window.currentUser = user;
  const surveyAllowed = user?.role === 'surveyor' || user?.role === 'admin';
  const isAdmin = user?.role === 'admin';
  const surveyWorkspace = $('surveyWorkspace');
  if (surveyWorkspace) surveyWorkspace.hidden = !surveyAllowed;
  if ($('statsDashboard')) $('statsDashboard').hidden = !surveyAllowed;
  if ($('statsAuthNote')) $('statsAuthNote').hidden = surveyAllowed;
  document.querySelectorAll('[data-admin-only]').forEach(element => { element.hidden = !isAdmin; });
  setLoginForm($('surveyLoginForm'), surveyAllowed ? user : null);
  setLoginForm($('adminLoginForm'), isAdmin ? user : null);
  setStatus('surveySessionStatus', surveyAllowed
    ? `${user.username} (${user.role === 'admin' ? 'प्रशासक' : 'सर्वेक्षक'}) म्हणून लॉगिन आहे.`
    : 'कुटुंब नोंदी पाहण्यासाठी सर्वेक्षक किंवा प्रशासक म्हणून लॉगिन करा.');
  setStatus('adminSessionStatus', isAdmin
    ? `${user.username} प्रशासक म्हणून लॉगिन आहेत.`
    : user
      ? `${user.username} सर्वेक्षक म्हणून लॉगिन आहेत. प्रशासकीय कृतींसाठी प्रशासक म्हणून लॉगिन करा.`
      : 'प्रशासकीय कृतींसाठी सर्व्हरने प्रशासक म्हणून पुष्टी करणे आवश्यक आहे.');
  $('surveyLogoutButton')?.toggleAttribute('hidden', !surveyAllowed);
  $('adminLogoutButton')?.toggleAttribute('hidden', !isAdmin);
  if (!surveyAllowed && window.familySurvey) window.familySurvey.clear();
  if (surveyAllowed && window.familySurvey) window.familySurvey.load();
  if (isAdmin) loadAdminQueue();
  else if ($('stage23PendingQueue')) $('stage23PendingQueue').innerHTML = '<p class="small-muted">प्रलंबित नोंदी पाहण्यासाठी प्रशासक म्हणून लॉगिन करा.</p>';
}
async function refreshSession() {
  try {
    const data = await apiRequest('/api/auth/me');
    updateSessionUI(data.user);
    return data.user;
  } catch (error) {
    if (error.status === 401) {
      updateSessionUI(null);
      return null;
    }
    window.refreshSession = refreshSession;
    setStatus('surveySessionStatus', `लॉगिन स्थिती तपासता आली नाही: ${errorText(error)}`);
    setStatus('adminSessionStatus', `लॉगिन स्थिती तपासता आली नाही: ${errorText(error)}`);
    return null;
  }
}
async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.querySelector('[name="username"]').value.trim();
  const password = form.querySelector('[name="password"]').value;
  const statusId = form.id === 'surveyLoginForm' ? 'surveySessionStatus' : 'adminSessionStatus';
  setStatus(statusId, 'लॉगिन तपासत आहे…');
  try {
    await apiRequest('/api/auth/login', { method: 'POST', body: { username, password } });
    const user = await refreshSession();
    if (!user) throw new Error('लॉगिन सत्राची पुष्टी करता आली नाही.');
    form.reset();
    if (user.role === 'admin') await loadAdminQueue();
    else setStatus('adminSessionStatus', 'सर्वेक्षणासाठी प्रवेश मिळाला; प्रशासकीय कृतींसाठी प्रशासक भूमिका आवश्यक आहे.');
  } catch (error) {
    setStatus(statusId, `लॉगिन झाले नाही: ${errorText(error)}`);
  }
}
$('surveyLoginForm')?.addEventListener('submit', handleLogin);
$('adminLoginForm')?.addEventListener('submit', handleLogin);
async function logout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
    updateSessionUI(null);
  } catch (error) {
    setStatus('adminSessionStatus', `लॉगआउट करता आले नाही: ${errorText(error)}`);
  }
}
$('surveyLogoutButton')?.addEventListener('click', logout);
$('adminLogoutButton')?.addEventListener('click', logout);

async function initialize() {
  await Promise.all([loadSuggestions(), loadWorkers()]);
  await refreshSession();
  await renderSkills();
}
initialize();
