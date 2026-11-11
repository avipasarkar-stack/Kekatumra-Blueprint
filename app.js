const navButtons = document.querySelectorAll('[data-page]');
const pages = document.querySelectorAll('.page');
const mainNav = document.getElementById('mainNav');
const menuToggle = document.getElementById('menuToggle');
function showPage(pageId) {
  const target = document.getElementById(pageId);
  if (!target || !target.classList.contains('page')) return;
  pages.forEach(page => page.classList.toggle('active', page === target));
  navButtons.forEach(button => button.classList.toggle('active', button.dataset.page === pageId));
  mainNav?.classList.remove('open');
  menuToggle?.setAttribute('aria-expanded', 'false');
  window.scrollTo({top: 0, behavior: 'smooth'});
  if (pageId === 'skills') renderSkills();
}
// Delegated handling also covers buttons rendered later by the कौशल्य सेतू search.
document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  const gotoButton = event.target.closest('[data-goto]');
  if (pageButton) { event.preventDefault(); showPage(pageButton.dataset.page); return; }
  if (gotoButton) { event.preventDefault(); showPage(gotoButton.dataset.goto); }
});
menuToggle?.addEventListener('click', () => {
  const open = mainNav?.classList.toggle('open') || false;
  menuToggle.setAttribute('aria-expanded', String(open));
});
const skillSearch = document.getElementById('skillSearch');
const skillCategory = document.getElementById('skillCategory');
const skillResults = document.getElementById('skillResults');
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderSkills() {
  if (!skillResults) return;
  const query = (skillSearch?.value || '').trim().toLocaleLowerCase('mr');
  const category = skillCategory?.value || '';
  let all = [];
  try { const saved = JSON.parse(localStorage.getItem('keketUmraSkilledWorkersStage25V1') || '[]'); if (Array.isArray(saved)) all = saved; } catch (_) {}
  const rows = all.filter(w => w.status === 'approved' && w.contactConsent)
    .filter(w => (!category || (w.skill || '').includes(category)) &&
      (!query || (w.name + ' ' + w.skill + ' ' + w.area + ' ' + w.description).toLocaleLowerCase('mr').includes(query)));
  skillResults.innerHTML = rows.length ? rows.map(w => `<article class="panel"><div class="service-icon">🛠️</div><h3>${esc(w.name)}</h3><b>${esc(w.skill)}</b><p>अनुभव: ${esc(w.experience)} वर्षे · ${esc(w.availability)}</p><p>${esc(w.description || '')}</p><p>सेवा क्षेत्र: ${esc(w.area)}</p><p><a href="tel:${esc(w.phone)}">संपर्क: ${esc(w.phone)}</a></p><button class="button button-light" data-goto="ratings">रेटिंग द्या</button></article>`).join('') : '<article class="panel"><h3>जुळणारे मंजूर प्रोफाइल नाही</h3><p>श्रेणी किंवा शब्द बदलून पाहा. तपासणी व मंजुरीनंतर नोंदणी येथे दिसेल.</p><button class="button button-primary" data-goto="workers">नोंदणी करा</button></article>';
}
document.getElementById('skillSearchBtn')?.addEventListener('click', renderSkills);
skillSearch?.addEventListener('input', renderSkills);
skillSearch?.addEventListener('keydown', event => { if (event.key === 'Enter') renderSkills(); });
skillCategory?.addEventListener('change', renderSkills);
window.addEventListener('stage25skillschange', renderSkills);
renderSkills();
