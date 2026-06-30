/* ============================================================
   AsistApp · app.js — Lógica principal (rediseño v2)
   ============================================================ */

'use strict';

// ════════════════════════════════════
// ESTADO GLOBAL
// ════════════════════════════════════
const state = {
  currentView:      'home',
  currentClassroom: null,
  currentSession:   null,
  classrooms:       [],
  students:         [],
  sessions:         [],
  absentIds:        new Set(),
  lateIds:          new Set(),
  importBuffer:     [],
  unsubClassrooms:  null,
  // Salón al que realmente pertenecen state.students/state.sessions ahora
  // mismo. Distinto de currentClassroom.id mientras loadStudents/loadSessions
  // todavía no terminan de cargar tras cambiar de salón — evita que reportes
  // (rFetchData) usen datos viejos de otro salón durante esa ventana.
  studentsDataFor:  null,
  sessionsDataFor:  null,
};

// Paleta — coincide con STRIPE_COLORS del prototipo
const CARD_COLORS = [
  { bg: '#EEF2FF', text: '#4361EE', stripe: '#4361EE' },
  { bg: '#ECFDF5', text: '#059669', stripe: '#059669' },
  { bg: '#F5F3FF', text: '#7C3AED', stripe: '#7C3AED' },
  { bg: '#FFFBEB', text: '#D97706', stripe: '#D97706' },
  { bg: '#FEF2F2', text: '#DC2626', stripe: '#DC2626' },
  { bg: '#E0F2FE', text: '#0891B2', stripe: '#0891B2' },
  { bg: '#FCE7F3', text: '#BE185D', stripe: '#BE185D' },
  { bg: '#F3F4F6', text: '#374151', stripe: '#374151' },
];

const AVATAR_COLORS = ['#4361EE','#059669','#7C3AED','#DC2626','#D97706','#0891B2','#BE185D','#374151'];

// Color estable por salón según su posición en la lista, para que los
// salones contiguos siempre se vean con colores distintos (no por hash).
// Mismo color en la pantalla de inicio y en la lista de salones.
function colorForClassroom(c) {
  // Si el docente eligió un color, se respeta.
  if (Number.isInteger(c.colorIdx) && c.colorIdx >= 0 && c.colorIdx < CARD_COLORS.length) {
    return CARD_COLORS[c.colorIdx];
  }
  // Si no, color automático por posición en la lista.
  const i = state.classrooms.findIndex(x => x.id === c.id);
  const idx = i >= 0 ? i : Math.abs(hashStr(c.id));
  return CARD_COLORS[idx % CARD_COLORS.length];
}

let db   = null;
let auth = null;
let currentUser = null; // usuario autenticado

// Detecta el error de Firestore "client has already been terminated":
// pasa cuando la conexión murió (típicamente porque la app se actualizó
// sola en segundo plano) y hay que recargar para reconectar.
function isClientTerminatedError(e) {
  const msg = (e && e.message) || '';
  return /already been terminated|client is offline/i.test(msg);
}
function showClientTerminatedToast() {
  showToast('⚠️ La app se actualizó — toca aquí para recargar');
  const el = document.getElementById('toast');
  if (el) el.onclick = () => window.location.reload();
}

// ════════════════════════════════════
// INIT
// ════════════════════════════════════
async function initApp() {
  try {
    db   = firebase.firestore();
    auth = firebase.auth();

    // IMPORTANTE: esperar a que la persistencia offline quede activa ANTES
    // de hacer cualquier consulta, para que los datos se guarden en el
    // caché del dispositivo y estén disponibles sin internet.
    try {
      await db.enablePersistence({ synchronizeTabs: true });
      console.log('[Offline] Persistencia activada ✓');
    } catch (err) {
      if (err.code === 'failed-precondition') {
        console.warn('[Offline] Múltiples pestañas — persistencia desactivada en esta pestaña');
      } else if (err.code === 'unimplemented') {
        console.warn('[Offline] Este navegador no soporta persistencia offline');
      } else {
        console.error('[Offline] Error al activar persistencia:', err);
      }
    }
  } catch (e) {
    console.warn('Firebase no disponible:', e.message);
    showToast('⚠️ Configura Firebase en firebase-config.js');
  }

  renderTodayDate();
  initSearch();
  initOfflineDetection();
  // Las settings se cargan en startApp(), cuando ya se conoce el usuario.
  loadSettingsLocal();

  // F7: Escuchar cambios de autenticación
  if (auth) {
    auth.onAuthStateChanged(user => onAuthChanged(user));
  } else {
    // Firebase no configurado — entrar sin auth
    startApp();
  }
}

// ── Manejo de estado de autenticación ───────────────────
function onAuthChanged(user) {
  currentUser = user;
  if (user) {
    // Usuario autenticado → iniciar la app
    renderMenuProfile(user);
    startApp();
  } else {
    // No autenticado → ir al login
    stopApp();
    navigateTo('login');
  }
}

function startApp() {
  // Mostrar nav, suscribir salones, cargar alertas
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  loadSettings().catch(() => {});
  subscribeClassrooms();
  navigateTo('home');
  setTimeout(() => loadAllAlerts().catch(() => {}), 3000);
  setTimeout(() => checkBackupReminder(), 5000);
}

function stopApp() {
  // Cancelar suscripción Firestore y limpiar estado
  if (state.unsubClassrooms) { state.unsubClassrooms(); state.unsubClassrooms = null; }
  state.classrooms = [];
  state.currentClassroom = null;
  _alertsCache = [];
  document.getElementById('bottom-nav')?.classList.add('hidden');
}

// ════════════════════════════════════
// FECHA
// ════════════════════════════════════
function renderTodayDate() {
  const now  = new Date();
  const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  const str  = now.toLocaleDateString('es-ES', opts);
  const el   = document.getElementById('today-date');
  if (el) el.textContent = str.charAt(0).toUpperCase() + str.slice(1);
}

function todayISO() {
  return toLocalISO(new Date());
}

// Fecha ISO (YYYY-MM-DD) en hora LOCAL, no UTC.
// toISOString() usa UTC: después de las 8pm (UTC-4) devolvía "mañana".
function toLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ════════════════════════════════════
// NAVEGACIÓN
// ════════════════════════════════════
// ── Protección: no salir de "pasar lista" con cambios sin guardar ──
let _skipAttendanceGuard = false;

function attendanceHasChanges() {
  if (state.currentView === 'take-attendance') {
    return state.absentIds.size > 0 || (state.lateIds?.size || 0) > 0 ||
      !!document.getElementById('attendance-topic')?.value.trim() ||
      !!document.getElementById('attendance-notes')?.value.trim();
  }
  if (state.currentView === 'swipe-attendance') {
    return Object.keys(swipe.decisions).length > 0;
  }
  return false;
}

function navigateTo(viewName, data = null) {
  // Si está pasando lista y hay cambios, confirmar antes de salir
  const guarded = ['take-attendance', 'swipe-attendance'];
  if (!_skipAttendanceGuard
      && guarded.includes(state.currentView)
      && viewName !== state.currentView
      && attendanceHasChanges()) {
    showConfirm(
      '¿Salir sin guardar?',
      'La asistencia que estás pasando se perderá si sales ahora.',
      () => {
        closeModal('modal-confirm');
        _skipAttendanceGuard = true;
        navigateTo(viewName, data);
        _skipAttendanceGuard = false;
      },
      'Salir'
    );
    return;
  }

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Nav inferior — solo primer nivel
  const navItem = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (navItem) navItem.classList.add('active');

  // FAB — solo en Home
  const fab = document.getElementById('fab');
  if (fab) fab.classList.toggle('hidden', viewName !== 'home');

  // Save bar — solo en Tomar Asistencia
  const savebar = document.getElementById('btn-save-attendance');
  if (savebar) savebar.classList.toggle('hidden', viewName !== 'take-attendance');

  // Btn Tomar Asistencia — solo en detalle salón
  const btnTA = document.getElementById('btn-take-attendance');
  if (btnTA) btnTA.classList.toggle('hidden', viewName !== 'classroom-detail');

  const view = document.getElementById(`view-${viewName}`);
  if (view) view.classList.add('active');
  state.currentView = viewName;

  switch (viewName) {
    case 'home':
      renderHomeClassrooms();
      updateHeroBanner();
      break;

    case 'stats':
      loadDashboard();
      break;

    case 'menu':
      renderMenuThreshold();
      break;

    case 'classrooms':
      renderClassroomsList();
      break;

    case 'classroom-detail': {
      const cls = data || state.currentClassroom;
      if (cls) {
        state.currentClassroom = cls;
        renderClassroomDetailHeader(cls);
        if (data) {
          // Navegación explícita a un salón: reset completo. Limpiar las
          // banderas de "datos cargados para X" para que reportes (rFetchData)
          // no reutilicen por error los datos del salón anterior mientras
          // este todavía está cargando.
          if (state.studentsDataFor !== cls.id) state.studentsDataFor = null;
          if (state.sessionsDataFor !== cls.id) state.sessionsDataFor = null;
          switchSegment('students');
          loadClassroomDetail(cls.id);
        } else {
          // Regreso desde Tomar Asistencia: refrescar sin cambiar pestaña
          loadStudents(cls.id);
          loadSessions(cls.id).then(() => updateDetailStats());
        }
      }
      break;
    }

    case 'take-attendance': {
      const ed = editingSession; // si venimos de "Editar clase"
      state.absentIds = new Set(ed ? getAbsentIds(ed) : []);
      state.lateIds   = new Set(ed ? (ed.lateStudents || []) : []);
      document.getElementById('attendance-date').value  = ed ? isoFromTimestamp(ed.date) : todayISO();
      document.getElementById('attendance-topic').value = ed ? (ed.topic || '') : '';
      document.getElementById('attendance-notes').value = ed ? (ed.notes || '') : '';
      const titleEl = document.getElementById('take-att-title');
      if (titleEl) titleEl.textContent = ed ? 'Editar Asistencia' : 'Tomar Asistencia';
      // Mostrar nombre del salón en el header
      const attSub = document.getElementById('take-att-classroom');
      if (attSub && state.currentClassroom) attSub.textContent = state.currentClassroom.name;
      renderAttendanceStudents();
      applyAttendanceMarks();
      updateAbsentCount();
      break;
    }

    case 'session-detail':
      if (data) {
        state.currentSession = data;
        renderSessionDetail(data);
      }
      break;

    case 'student-profile':
      loadStudentProfile();
      break;

    case 'reports':
      if (typeof loadReportsView === 'function') loadReportsView();
      break;

    case 'projection':
      loadProjectionView();
      break;

    case 'alerts':
      _alertFilter = 'all';
      loadAlertsView();
      break;

    case 'swipe-attendance':
      break;

    case 'login':
    case 'register':
    case 'forgot-password':
      // Vistas de auth: ocultar nav
      document.getElementById('bottom-nav')?.classList.add('hidden');
      break;

    case 'profile':
      loadProfileView();
      break;
  }

  // Mostrar nav solo en vistas principales (no en auth ni proyección)
  const authViews = ['login', 'register', 'forgot-password'];
  const noNavViews = [...authViews, 'projection'];
  if (!noNavViews.includes(viewName)) {
    document.getElementById('bottom-nav')?.classList.remove('hidden');
  }
}

// ════════════════════════════════════
// PROYECCIÓN EN VIVO (F5)
// ════════════════════════════════════
let _projUnsub = null; // listener Firestore activo

function loadProjectionView() {
  const cls = state.currentClassroom;
  if (!cls) { navigateTo('home'); return; }

  // Rellenar encabezado
  const nameEl = document.getElementById('proj-classroom-name');
  const subEl  = document.getElementById('proj-classroom-sub');
  const dateEl = document.getElementById('proj-date');
  if (nameEl) nameEl.textContent = cls.name;
  if (subEl)  subEl.textContent  = [cls.subject, cls.grade].filter(Boolean).join(' · ');
  if (dateEl) {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString('es-ES', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    dateEl.textContent = dateEl.textContent.charAt(0).toUpperCase() + dateEl.textContent.slice(1);
  }

  // Ocultar nav y FAB
  document.getElementById('bottom-nav')?.classList.add('hidden');
  document.getElementById('fab')?.classList.add('hidden');

  // Intentar pantalla completa
  const viewEl = document.getElementById('view-projection');
  if (viewEl?.requestFullscreen) viewEl.requestFullscreen().catch(() => {});

  // Suscribirse a la sesión de hoy en tiempo real
  _subscribeProjection(cls.id);
}

function _subscribeProjection(classroomId) {
  // Cancelar listener anterior si existe
  if (_projUnsub) { _projUnsub(); _projUnsub = null; }
  if (!db) { _showProjEmpty(); return; }

  const today = todayISO();

  _projUnsub = db.collection('classrooms').doc(classroomId)
    .collection('sessions')
    .orderBy('date', 'desc')
    .limit(3)
    .onSnapshot(async snap => {
      if (snap.empty) { _showProjEmpty(); return; }

      // Buscar sesión de hoy
      const todaySess = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .find(s => isoFromTimestamp(s.date) === today);

      if (!todaySess) { _showProjEmpty(); return; }

      // Cargar alumnos (una vez es suficiente, son datos estáticos)
      let students = state.students;
      if (!students.length) {
        const snap2 = await db.collection('classrooms').doc(classroomId)
          .collection('students').orderBy('name').get();
        students = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
      }

      _renderProjection(todaySess, students);
    }, err => {
      console.error('[Proyección]', err);
      _showProjEmpty();
    });
}

function _renderProjection(session, students) {
  const gridEl   = document.getElementById('proj-student-grid');
  const noSessEl = document.getElementById('proj-no-session');
  if (!gridEl) return;

  noSessEl?.classList.add('hidden');
  gridEl.style.display = '';

  const absentIds = getAbsentIds(session);
  const present   = students.length - absentIds.length;
  const absent    = absentIds.length;
  const pct       = students.length > 0 ? Math.round(present / students.length * 100) : 100;

  // Stats
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('proj-present-count', present);
  set('proj-absent-count',  absent);
  set('proj-total-count',   students.length);
  set('proj-pct',           pct + '%');

  // Colorear % según nivel
  const pctEl = document.getElementById('proj-pct');
  if (pctEl) pctEl.style.color = pct >= 90 ? '#34D399' : pct >= 75 ? '#FCD34D' : '#F87171';

  // Tema de la clase
  const topicEl = document.getElementById('proj-topic');
  if (topicEl) {
    if (session.topic) {
      topicEl.style.display = '';
      topicEl.innerHTML = `<strong>Tema:</strong> ${esc(session.topic)}`;
    } else {
      topicEl.style.display = 'none';
    }
  }

  // Grid de alumnos
  gridEl.innerHTML = students.map((st, i) => {
    const isAbsent  = absentIds.includes(st.id);
    const status    = isAbsent ? 'absent' : 'present';
    const label     = isAbsent ? 'AUSENTE' : 'PRESENTE';
    const ini       = st.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const bg        = AVATAR_COLORS[i % AVATAR_COLORS.length];
    return `
      <div class="proj-card ${status}">
        <div class="proj-card-avatar" style="background:${isAbsent ? '' : bg};${isAbsent ? '' : ''}">${ini}</div>
        <div class="proj-card-name">${esc(st.name)}</div>
        <div class="proj-card-status">${label}</div>
      </div>`;
  }).join('');
}

function _showProjEmpty() {
  const gridEl   = document.getElementById('proj-student-grid');
  const noSessEl = document.getElementById('proj-no-session');
  if (gridEl) gridEl.style.display = 'none';
  noSessEl?.classList.remove('hidden');

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('proj-present-count', '—');
  set('proj-absent-count',  '—');
  set('proj-total-count',   '—');
  set('proj-pct',           '—');
}

function exitProjection() {
  // Cancelar listener
  if (_projUnsub) { _projUnsub(); _projUnsub = null; }

  // Salir de pantalla completa
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  // Restaurar nav y FAB
  document.getElementById('bottom-nav')?.classList.remove('hidden');

  navigateTo('classroom-detail');
}

// ════════════════════════════════════
// HERO BANNER (Home)
// ════════════════════════════════════
function updateHeroBanner() {
  const hero      = document.getElementById('home-hero');
  const heroTitle = document.getElementById('hero-title');
  if (!hero || !heroTitle) return;

  if (state.classrooms.length === 0) {
    hero.className = 'aa-hero';
    heroTitle.textContent = 'Agrega tu primer salón tocando el +';
    return;
  }

  // Busca si hay algún salón sin sesión hoy
  const today = todayISO();
  const pending = state.classrooms.find(c => {
    const lastISO = state._lastSessions?.[c.id]?.dateISO;
    if (!lastISO) return true;
    return lastISO !== today;
  });

  if (pending) {
    hero.className = 'aa-hero';
    heroTitle.textContent = `¿Tomaste la asistencia de ${pending.name}?`;
    hero.onclick = () => {
      const classroom = state.classrooms.find(c => c.id === pending.id);
      if (classroom) {
        navigateTo('classroom-detail', classroom);
        setTimeout(() => openTakeAttendance(), 100);
      }
    };
  } else {
    hero.className = 'aa-hero green';
    heroTitle.textContent = '¡Todo al día! Sin asistencias pendientes ✓';
    hero.onclick = null;
  }
}

// ════════════════════════════════════
// SEGMENTED CONTROL (Detalle Salón)
// ════════════════════════════════════
function switchSegment(seg) {
  const segStudents = document.getElementById('seg-students');
  const segHistory  = document.getElementById('seg-history');
  const panelStudents = document.getElementById('panel-students');
  const panelHistory  = document.getElementById('panel-history');

  if (seg === 'students') {
    segStudents?.classList.add('active');
    segHistory?.classList.remove('active');
    panelStudents?.classList.remove('hidden');
    panelHistory?.classList.add('hidden');
  } else {
    segStudents?.classList.remove('active');
    segHistory?.classList.add('active');
    panelStudents?.classList.add('hidden');
    panelHistory?.classList.remove('hidden');
  }
}

// ════════════════════════════════════
// SALONES — Suscripción en tiempo real
// ════════════════════════════════════
function subscribeClassrooms() {
  if (!db) return;
  if (state.unsubClassrooms) state.unsubClassrooms();

  // F7: filtrar por ownerId si hay usuario autenticado
  const uid = auth?.currentUser?.uid;
  let query = db.collection('classrooms').orderBy('createdAt', 'asc');
  if (uid) query = query.where('ownerId', '==', uid);

  state.unsubClassrooms = query.onSnapshot(snapshot => {
    state.classrooms = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderClassroomsList();
    renderHomeClassrooms();
    loadCardCounts();
    buildGlobalIndex();
  }, err => {
    console.error('Error salones:', err);
    if (!navigator.onLine) showToast('Sin conexión — mostrando datos guardados');
  });
}

// ════════════════════════════════════
// RENDER — Home classrooms (grid 2col)
// ════════════════════════════════════
function renderHomeClassrooms() {
  const container = document.getElementById('home-classrooms');
  const empty     = document.getElementById('home-empty');
  if (!container) return;

  if (state.classrooms.length === 0) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  container.innerHTML = state.classrooms.map(c => classroomGridCardHTML(c)).join('');
}

function classroomGridCardHTML(c) {
  const color = colorForClassroom(c);
  const sub   = [c.subject, c.grade].filter(Boolean).join(' · ') || 'Sin materia';

  return `
    <div class="classroom-card" onclick="openClassroom('${c.id}')">
      <div class="card-stripe" style="background:${color.stripe}"></div>
      <div class="card-icon" style="background:${color.bg};color:${color.text}">🏫</div>
      <div class="card-name">${esc(c.name)}</div>
      <div class="card-subject">${esc(sub)}</div>
      <div class="card-count" id="card-count-${c.id}"
           style="background:${color.bg};color:${color.text}">— alumnos</div>
    </div>`;
}

// ════════════════════════════════════
// RENDER — Lista de Salones (list)
// ════════════════════════════════════
function renderClassroomsList() {
  const container = document.getElementById('classrooms-list');
  const empty     = document.getElementById('classrooms-empty');
  if (!container) return;

  if (state.classrooms.length === 0) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  container.innerHTML = state.classrooms.map(c => classroomListItemHTML(c)).join('');
}

function classroomListItemHTML(c) {
  const color = colorForClassroom(c);
  const sub   = [c.subject, c.grade].filter(Boolean).join(' · ') || 'Sin materia';

  return `
    <div class="classroom-list-item" onclick="openClassroom('${c.id}')">
      <div class="item-stripe" style="background:${color.stripe}"></div>
      <div class="item-icon" style="background:${color.bg};color:${color.text}">🏫</div>
      <div class="item-info">
        <div class="item-name">${esc(c.name)}</div>
        <div class="item-subject">${esc(sub)}</div>
      </div>
      <div class="item-count" id="list-count-${c.id}"
           style="background:${color.bg};color:${color.text}">—</div>
      <span class="chevron">›</span>
    </div>`;
}

function openClassroom(classroomId) {
  const classroom = state.classrooms.find(c => c.id === classroomId);
  if (classroom) navigateTo('classroom-detail', classroom);
}

// ════════════════════════════════════
// Conteo de alumnos + última sesión por salón
// ════════════════════════════════════
async function loadCardCounts() {
  if (!db) return;
  if (!state._lastSessions) state._lastSessions = {};

  // Todos los salones en paralelo (antes era uno por uno)
  await Promise.all(state.classrooms.map(async c => {
    try {
      // Conteo: usar studentCount desnormalizado (0 lecturas).
      // Fallback para salones viejos que aún no lo tienen guardado.
      let n = c.studentCount;
      if (typeof n !== 'number') {
        const studSnap = await db.collection('classrooms').doc(c.id).collection('students').get();
        n = studSnap.size;
        syncStudentCount(c.id, n);
      }

      const txt = `${n} alumno${n !== 1 ? 's' : ''}`;
      const el1 = document.getElementById(`card-count-${c.id}`);
      const el2 = document.getElementById(`list-count-${c.id}`);
      if (el1) el1.textContent = txt;
      if (el2) el2.textContent = txt;

      // Última sesión (para el hero banner): usar fecha desnormalizada.
      // Fallback con 1 lectura para salones que aún no la tienen.
      let iso = c.lastSessionISO;
      if (iso === undefined) {
        const sessSnap = await db.collection('classrooms').doc(c.id).collection('sessions')
          .orderBy('date', 'desc').limit(1).get();
        iso = sessSnap.empty ? null : isoFromTimestamp(sessSnap.docs[0].data().date);
        c.lastSessionISO = iso;
        db.collection('classrooms').doc(c.id).update({ lastSessionISO: iso }).catch(() => {});
      }
      state._lastSessions[c.id] = iso ? { dateISO: iso } : null;
    } catch { /* ignorar */ }
  }));
  updateHeroBanner();
}

// ════════════════════════════════════
// DETALLE DE SALÓN — header dark
// ════════════════════════════════════
function renderClassroomDetailHeader(classroom) {
  const nameEl = document.getElementById('detail-classroom-name');
  const subEl  = document.getElementById('detail-classroom-sub');
  if (nameEl) nameEl.textContent = classroom.name;
  if (subEl)  subEl.textContent  = [classroom.subject, classroom.grade].filter(Boolean).join(' · ') || '';

  // Teñir la cabecera con el color elegido para el salón.
  const header = document.getElementById('detail-dark-header');
  if (header) {
    const col = colorForClassroom(classroom);
    header.style.background = `linear-gradient(160deg, ${col.stripe} 0%, rgba(0,0,0,0.55) 150%)`;
  }
}

// ════════════════════════════════════
// CARGAR DETALLE
// ════════════════════════════════════
async function loadClassroomDetail(classroomId) {
  await Promise.all([
    loadStudents(classroomId),
    loadSessions(classroomId),
  ]);
  updateDetailStats();
}

function updateDetailStats() {
  const st = document.getElementById('detail-stat-students');
  const ss = document.getElementById('detail-stat-sessions');
  const sa = document.getElementById('detail-stat-absent');
  if (st) st.textContent = state.students.length;
  if (ss) ss.textContent = state.sessions.length;
  const totalAbsent = state.sessions.reduce((acc, s) => acc + (s.absentStudents?.length || 0), 0);
  if (sa) sa.textContent = totalAbsent;
}

// ════════════════════════════════════
// ESTUDIANTES
// ════════════════════════════════════
async function loadStudents(classroomId) {
  if (!db) return;
  try {
    const snap    = await db.collection('classrooms').doc(classroomId)
      .collection('students').orderBy('name').get();
    // Evitar condición de carrera: si el usuario ya cambió de salón
    // mientras cargaba, ignorar este resultado (era de otro salón).
    if (state.currentClassroom && state.currentClassroom.id !== classroomId) return;
    state.students = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    state.studentsDataFor = classroomId;
    renderStudentsList();
    syncStudentCount(classroomId, state.students.length);
  } catch (e) { console.error('Error estudiantes:', e); }
}

// Mantiene studentCount desnormalizado en el doc del salón.
// Solo escribe si cambió (migra salones viejos automáticamente).
function syncStudentCount(classroomId, count) {
  const c = state.classrooms.find(x => x.id === classroomId);
  if (c && c.studentCount === count) return;
  if (c) c.studentCount = count;
  if (state.currentClassroom?.id === classroomId) state.currentClassroom.studentCount = count;
  db.collection('classrooms').doc(classroomId)
    .update({ studentCount: count })
    .catch(() => {}); // sin permisos u offline: se reintenta en la próxima carga
}

function renderStudentsList() {
  const container = document.getElementById('students-list');
  const empty     = document.getElementById('students-empty');
  if (!container) return;

  if (state.students.length === 0) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  container.innerHTML = state.students.map((s, i) => {
    const bg = AVATAR_COLORS[i % AVATAR_COLORS.length];
    return `
      <div class="aa-srow" style="cursor:pointer;"
           onclick="openStudentProfile('${s.id}')">
        <div class="aa-avatar sm" style="background:${bg}">${initials(s.name)}</div>
        <span class="srow-name">${esc(s.name)}</span>
        <span class="aa-badge none" style="cursor:pointer"
              onclick="event.stopPropagation();openEditStudent('${s.id}')">✏️</span>
        <span class="aa-badge none" style="cursor:pointer"
              onclick="event.stopPropagation();confirmDeleteStudent('${s.id}')">✕</span>
      </div>`;
  }).join('');
}

// botones del detalle de salón
let editingStudentId = null; // null = agregar; id = editar nombre

function openAddStudent() {
  editingStudentId = null;
  const titleEl = document.getElementById('modal-student-title');
  const btnEl   = document.getElementById('modal-student-btn');
  if (titleEl) titleEl.textContent = 'Agregar Alumno';
  if (btnEl)   btnEl.textContent   = 'Agregar';
  const ta   = document.getElementById('student-name');
  const hint = document.getElementById('student-name-hint');
  ta.value = '';
  if (hint) hint.textContent = '';
  // Actualizar contador de nombres en vivo mientras se escribe/pega
  ta.oninput = () => {
    const n = parseStudentNames(ta.value).length;
    if (hint) hint.textContent = n > 1 ? `Se agregarán ${n} alumnos` : '';
  };
  openModal('modal-student');
  setTimeout(() => ta.focus(), 320);
}

// Editar el nombre de un alumno existente (reusa el modal de agregar)
function openEditStudent(studentId) {
  const s = state.students.find(x => x.id === studentId);
  if (!s) return;
  editingStudentId = studentId;
  const titleEl = document.getElementById('modal-student-title');
  const btnEl   = document.getElementById('modal-student-btn');
  if (titleEl) titleEl.textContent = 'Editar Alumno';
  if (btnEl)   btnEl.textContent   = 'Guardar';
  const ta   = document.getElementById('student-name');
  const hint = document.getElementById('student-name-hint');
  ta.value = s.name || '';
  ta.oninput = null;
  if (hint) hint.textContent = '';
  openModal('modal-student');
  setTimeout(() => { ta.focus(); ta.select?.(); }, 320);
}

// Convierte el texto pegado en una lista limpia de nombres.
// Separa por saltos de línea, quita numeraciones tipo "1." o "1)",
// elimina espacios extra y descarta líneas vacías o duplicadas.
function parseStudentNames(raw) {
  const seen = new Set();
  return (raw || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+[.)\-:]?\s*/, '').trim())
    .filter(name => {
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function saveStudent() {
  const raw = document.getElementById('student-name').value;
  const names = parseStudentNames(raw);
  if (names.length === 0) { showToast('Escribe el nombre'); return; }
  if (!state.currentClassroom) return;

  try {
    const studentsRef = db.collection('classrooms')
      .doc(state.currentClassroom.id).collection('students');

    // Modo edición: solo renombrar
    if (editingStudentId) {
      await studentsRef.doc(editingStudentId).update({ name: names[0] });
      editingStudentId = null;
      showToast('Nombre actualizado ✓');
      closeModal('modal-student');
      await loadStudents(state.currentClassroom.id);
      return;
    }

    if (names.length === 1) {
      await studentsRef.add({
        name: names[0],
        addedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showToast('Alumno agregado ✓');
    } else {
      // Varios nombres → agregar en lote
      const batch = db.batch();
      names.forEach(name => {
        batch.set(studentsRef.doc(), {
          name,
          addedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      showToast(`${names.length} alumnos agregados ✓`);
    }

    closeModal('modal-student');
    await loadStudents(state.currentClassroom.id);
    updateDetailStats();
  } catch (e) {
    console.error(e);
    showToast('Error al agregar');
  }
}

function confirmDeleteStudent(studentId) {
  const s = state.students.find(x => x.id === studentId);
  if (!s) return;
  showConfirm(
    'Eliminar Alumno',
    `¿Eliminar a "${s.name}" de este salón?`,
    async () => {
      try {
        await db.collection('classrooms').doc(state.currentClassroom.id)
          .collection('students').doc(studentId).delete();
        showToast('Alumno eliminado');
        closeModal('modal-confirm');
        await loadStudents(state.currentClassroom.id);
        updateDetailStats();
      } catch { showToast('Error al eliminar'); }
    }
  );
}

// ════════════════════════════════════
// IMPORTAR EXCEL/CSV
// ════════════════════════════════════
function openImportStudents() {
  state.importBuffer = [];
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = '';
  document.getElementById('import-preview')?.classList.add('hidden');
  const btn = document.getElementById('btn-confirm-import');
  if (btn) { btn.disabled = true; }
  openModal('modal-import');
}

function handleFileImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb   = XLSX.read(data, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

      const names = rows
        .map(row => String(row[0] || '').trim())
        .filter(n => n.length > 1 && !/^(nombre|name|alumno|student|apellido)/i.test(n));

      if (names.length === 0) {
        showToast('No se encontraron nombres en el archivo');
        return;
      }

      state.importBuffer = names;

      document.getElementById('import-count-text').textContent =
        `✓ ${names.length} alumno${names.length !== 1 ? 's' : ''} encontrado${names.length !== 1 ? 's' : ''}`;

      const listEl = document.getElementById('import-names-list');
      if (listEl) {
        const preview = names.slice(0, 20).map(n =>
          `<div class="import-name-item">${esc(n)}</div>`).join('');
        const more = names.length > 20
          ? `<div style="color:var(--c-text-muted);font-size:11px;padding-top:4px">...y ${names.length - 20} más</div>`
          : '';
        listEl.innerHTML = preview + more;
      }

      document.getElementById('import-preview')?.classList.remove('hidden');
      const btn = document.getElementById('btn-confirm-import');
      if (btn) btn.disabled = false;
    } catch (err) {
      console.error(err);
      showToast('Error leyendo el archivo');
    }
  };
  reader.readAsArrayBuffer(file);
}

async function confirmImport() {
  if (!state.importBuffer.length || !state.currentClassroom) return;

  const btn = document.getElementById('btn-confirm-import');
  if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

  try {
    const colRef = db.collection('classrooms').doc(state.currentClassroom.id).collection('students');
    const batch  = db.batch();
    const ts     = firebase.firestore.FieldValue.serverTimestamp();
    state.importBuffer.forEach(name => batch.set(colRef.doc(), { name, addedAt: ts }));
    await batch.commit();

    showToast(`${state.importBuffer.length} alumnos importados ✓`);
    closeModal('modal-import');
    await loadStudents(state.currentClassroom.id);
    updateDetailStats();
  } catch (e) {
    console.error(e);
    showToast('Error al importar');
    if (btn) { btn.disabled = false; btn.textContent = 'Importar'; }
  }
}

// ════════════════════════════════════
// SESIONES
// ════════════════════════════════════
async function loadSessions(classroomId) {
  if (!db) return;
  try {
    const snap    = await db.collection('classrooms').doc(classroomId)
      .collection('sessions').orderBy('date', 'desc').get();
    // Evitar condición de carrera: si el usuario ya cambió de salón
    // mientras cargaba, ignorar este resultado (era de otro salón).
    if (state.currentClassroom && state.currentClassroom.id !== classroomId) return;
    state.sessions = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    state.sessionsDataFor = classroomId;
    renderSessionsList();
    syncLastSessionISO(classroomId);
  } catch (e) { console.error('Error sesiones:', e); }
}

// Mantiene lastSessionISO desnormalizado en el doc del salón.
// loadSessions corre tras guardar/editar/eliminar clases, así queda siempre al día.
function syncLastSessionISO(classroomId) {
  const newest = state.sessions[0]; // vienen ordenadas desc
  const iso = newest ? isoFromTimestamp(newest.date) : null;
  if (!state._lastSessions) state._lastSessions = {};
  state._lastSessions[classroomId] = iso ? { dateISO: iso } : null;
  const c = state.classrooms.find(x => x.id === classroomId);
  if (c && c.lastSessionISO === iso) return;
  if (c) c.lastSessionISO = iso;
  db.collection('classrooms').doc(classroomId)
    .update({ lastSessionISO: iso })
    .catch(() => {});
}

function renderSessionsList() {
  const container = document.getElementById('sessions-list');
  const empty     = document.getElementById('sessions-empty');
  if (!container) return;

  if (state.sessions.length === 0) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  container.innerHTML = state.sessions.map(s => {
    const absentCount = (s.absentStudents || []).length;
    const badge = absentCount > 0
      ? `<span class="aa-badge absent">✗ ${absentCount} ausente${absentCount !== 1 ? 's' : ''}</span>`
      : `<span class="aa-badge present">✓ Completa</span>`;

    return `
      <div class="aa-session" onclick="openSession('${s.id}')">
        <div class="sess-row1">
          <span class="sess-date">${formatDate(s.date)}</span>
          ${badge}
        </div>
        <div class="sess-topic">${esc(s.topic || 'Sin tema')}</div>
        ${s.notes ? `<div class="sess-note">${esc(s.notes)}</div>` : ''}
      </div>`;
  }).join('');
}

function openSession(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (session) {
    // guardamos el salón en el botón back de sesión
    const backBtn = document.getElementById('session-back-btn');
    if (backBtn) backBtn.onclick = () => navigateTo('classroom-detail', state.currentClassroom);
    // info del salón en el header
    const clsEl = document.getElementById('session-detail-classroom');
    if (clsEl && state.currentClassroom) {
      clsEl.textContent = [state.currentClassroom.name, state.currentClassroom.subject].filter(Boolean).join(' · ');
    }
    navigateTo('session-detail', session);
  }
}

// ════════════════════════════════════
// TOMAR ASISTENCIA
// ════════════════════════════════════
let editingSession = null; // sesión que se está editando (null = nueva)
let _dupOverride   = false; // el usuario confirmó guardar duplicado

// Si ya hay una clase ese día, pide confirmación y devuelve true (frena el guardado).
// `retry` se llama si el usuario confirma guardar de todos modos.
function checkDuplicateSession(dateISO, retry) {
  if (editingSession || _dupOverride) { _dupOverride = false; return false; }
  const exists = state.sessions.some(s => isoFromTimestamp(s.date) === dateISO);
  if (!exists) return false;
  showConfirm(
    'Clase duplicada',
    `Ya registraste una clase el ${formatDateLong(new Date(dateISO + 'T12:00:00'))} en este salón.\n¿Guardar otra de todos modos?`,
    () => {
      closeModal('modal-confirm');
      _dupOverride = true;
      retry();
    },
    'Guardar igual'
  );
  return true;
}

function openTakeAttendance() {
  editingSession = null;
  navigateTo('take-attendance');
}

// Editar una clase ya guardada: reusa la vista de tomar asistencia
function openEditSession() {
  const s = state.currentSession;
  if (!s || !state.currentClassroom) return;
  editingSession = s;
  navigateTo('take-attendance');
}

// Marca visualmente ausentes/tardes ya registrados (modo edición)
function applyAttendanceMarks() {
  const mark = (id, cls, badge, txt, bg, fg) => {
    const item   = document.getElementById(`att-item-${id}`);
    const status = document.getElementById(`att-status-${id}`);
    const avatar = document.getElementById(`att-avatar-${id}`);
    item?.classList.add(cls);
    if (status) { status.className = `aa-badge ${badge}`; status.textContent = txt; }
    if (avatar) { avatar.style.background = bg; avatar.style.color = fg; }
  };
  state.absentIds.forEach(id => mark(id, 'absent', 'absent', '✗ Ausente', '#FCA5A5', '#7f1d1d'));
  (state.lateIds || new Set()).forEach(id => mark(id, 'late', 'late', '🕐 Tarde', '#FDE68A', '#92400E'));
}

// Eliminar la clase abierta en detalle de sesión
function confirmDeleteSession() {
  const s   = state.currentSession;
  const cls = state.currentClassroom;
  if (!s || !cls) return;
  showConfirm(
    'Eliminar Clase',
    `¿Eliminar la clase del ${formatDateLong(s.date)}?\nEsta acción no se puede deshacer.`,
    async () => {
      try {
        await db.collection('classrooms').doc(cls.id)
          .collection('sessions').doc(s.id).delete();
        closeModal('modal-confirm');
        showToast('Clase eliminada');
        state.currentSession = null;
        navigateTo('classroom-detail');
        switchSegment('history');
      } catch (e) {
        console.error(e);
        showToast('Error al eliminar');
      }
    }
  );
}

function renderAttendanceStudents() {
  const container = document.getElementById('attendance-students-list');
  if (!container) return;

  if (state.students.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <div class="empty-title">Sin alumnos</div>
        <div class="empty-sub">Agrega alumnos al salón primero</div>
      </div>`;
    return;
  }

  container.innerHTML = state.students.map((s, i) => {
    const bg = AVATAR_COLORS[i % AVATAR_COLORS.length];
    return `
      <div class="attendance-student-row" id="att-item-${s.id}" onclick="toggleAbsent('${s.id}')">
        <span class="att-list-num">${i + 1}</span>
        <div class="aa-avatar sm" id="att-avatar-${s.id}" style="background:${bg}">${initials(s.name)}</div>
        <span class="student-name">${esc(s.name)}</span>
        <span class="aa-badge present" id="att-status-${s.id}">✓ Presente</span>
      </div>`;
  }).join('');
}

// Tocar la fila rota el estado: Presente → Tarde → Ausente → Presente.
function toggleAbsent(studentId) {
  const item   = document.getElementById(`att-item-${studentId}`);
  const status = document.getElementById(`att-status-${studentId}`);
  const avatar = document.getElementById(`att-avatar-${studentId}`);
  const idx    = state.students.findIndex(s => s.id === studentId);
  const baseColor = AVATAR_COLORS[idx % AVATAR_COLORS.length];

  if (!state.lateIds) state.lateIds = new Set();
  const isAbsent = state.absentIds.has(studentId);
  const isLate   = state.lateIds.has(studentId);

  if (!isAbsent && !isLate) {
    // Presente → Tarde
    state.lateIds.add(studentId);
    item?.classList.remove('absent'); item?.classList.add('late');
    if (status) { status.className = 'aa-badge late'; status.textContent = '🕐 Tarde'; }
    if (avatar) { avatar.style.background = '#FDE68A'; avatar.style.color = '#92400E'; }
  } else if (isLate) {
    // Tarde → Ausente
    state.lateIds.delete(studentId);
    state.absentIds.add(studentId);
    item?.classList.remove('late'); item?.classList.add('absent');
    if (status) { status.className = 'aa-badge absent'; status.textContent = '✗ Ausente'; }
    if (avatar) { avatar.style.background = '#FCA5A5'; avatar.style.color = '#7f1d1d'; }
  } else {
    // Ausente → Presente
    state.absentIds.delete(studentId);
    item?.classList.remove('absent');
    if (status) { status.className = 'aa-badge present'; status.textContent = '✓ Presente'; }
    if (avatar) { avatar.style.background = baseColor; avatar.style.color = ''; }
  }
  updateAbsentCount();
}

function updateAbsentCount() {
  const n  = state.absentIds.size;
  const l  = state.lateIds ? state.lateIds.size : 0;
  const el = document.getElementById('absent-count');
  if (!el) return;
  let txt = `${n} ausente${n !== 1 ? 's' : ''}`;
  if (l > 0) txt += ` · ${l} tarde`;
  el.textContent = txt;
  el.className   = (n > 0 || l > 0) ? 'aa-badge absent' : 'aa-badge primary';
}

async function saveAttendance() {
  if (!state.currentClassroom) { showToast('Sin salón seleccionado'); return; }

  // Leer los campos de forma defensiva: si el DOM no está listo (re-render
  // tardío, vista recién montada, etc.) esto antes tronaba en silencio y
  // el botón "Guardar" no hacía nada sin avisar. Ahora se detecta y se
  // pide reintentar en vez de fallar mudo.
  const dateEl  = document.getElementById('attendance-date');
  const topicEl = document.getElementById('attendance-topic');
  const notesEl = document.getElementById('attendance-notes');
  if (!dateEl || !topicEl || !notesEl) {
    showToast('⚠️ La pantalla no cargó bien — vuelve a abrir "Tomar Asistencia" e inténtalo de nuevo');
    return;
  }

  const dateVal = dateEl.value;
  const topic   = topicEl.value.trim();
  const notes   = notesEl.value.trim();

  if (!dateVal) { markFieldInvalid('attendance-date', '⚠️ Selecciona la fecha'); return; }
  if (!topic)   { markFieldInvalid('attendance-topic', '⚠️ Falta el tema de la clase'); return; }

  // Aviso si ya existe una clase ese día en este salón (evita duplicados)
  if (checkDuplicateSession(dateVal, () => saveAttendance())) return;

  const sessionData = {
    date:           firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    topic,
    notes,
    absentStudents: Array.from(state.absentIds),
    lateStudents:   Array.from(state.lateIds || []),
    totalStudents:  state.students.length,
    createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    // No usamos await en la escritura: si estamos offline, Firestore no
    // resuelve la promesa hasta reconectar y la app se quedaría colgada.
    // El dato se guarda localmente y se sincroniza solo al volver la red.
    const sessionsCol = db.collection('classrooms').doc(state.currentClassroom.id)
      .collection('sessions');

    if (editingSession) {
      // EDICIÓN: actualizar la sesión existente conservando justificaciones
      const justifById = {};
      (editingSession.absentStudents || []).forEach(a => {
        if (typeof a === 'object' && a.justification) justifById[a.studentId] = a;
      });
      sessionData.absentStudents = Array.from(state.absentIds)
        .map(id => justifById[id] || id);
      delete sessionData.createdAt;
      sessionData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      sessionsCol.doc(editingSession.id).update(sessionData).catch(err => {
        console.error('[Sync] Error al actualizar asistencia:', err);
        if (isClientTerminatedError(err)) { showClientTerminatedToast(); }
        else if (navigator.onLine) showToast('⚠️ No se pudo sincronizar — revisa la conexión e inténtalo de nuevo');
      });
      editingSession = null;
    } else {
      sessionsCol.doc().set(sessionData).catch(err => {
        console.error('[Sync] Error al sincronizar asistencia:', err);
        if (isClientTerminatedError(err)) { showClientTerminatedToast(); }
        else if (navigator.onLine) showToast('⚠️ No se pudo sincronizar — revisa la conexión e inténtalo de nuevo');
      });
    }

    showToast(navigator.onLine ? 'Asistencia guardada ✓' : 'Guardada offline — se sincronizará al reconectar ✓');
    _skipAttendanceGuard = true;
    navigateTo('classroom-detail', state.currentClassroom);
    _skipAttendanceGuard = false;
    await loadSessions(state.currentClassroom.id);
    switchSegment('history');
    // Mostrar números de lista de ausentes para el diario
    // (ids puros: en edición absentStudents puede traer objetos con justificación)
    showInasistenciasModal(Array.from(state.absentIds));

    // F6: Evaluar alertas en background (no bloqueante)
    evaluateAlerts(state.currentClassroom.id).then(alerts => {
      // Actualizar cache con las alertas del salón actual
      _alertsCache = _alertsCache.filter(a => a.classroomId !== state.currentClassroom.id);
      _alertsCache.push(...alerts);
      updateAlertBadge();
    }).catch(() => {});
  } catch (e) {
    console.error(e);
    showToast('Error al guardar asistencia');
  }
}

// ════════════════════════════════════
// DETALLE DE SESIÓN
// ════════════════════════════════════
function renderSessionDetail(session) {
  // Header
  const dateEl = document.getElementById('session-detail-date');
  if (dateEl) dateEl.textContent = formatDateLong(session.date);

  // Topic card
  const topicEl = document.getElementById('session-topic-value');
  const notesEl = document.getElementById('session-notes-value');
  if (topicEl) topicEl.textContent = session.topic || 'Sin tema';
  if (notesEl) {
    notesEl.textContent = session.notes || '';
    notesEl.classList.toggle('hidden', !session.notes);
  }

  // Stats
  const absentIds    = getAbsentIds(session);
  const total        = session.totalStudents  || state.students.length;
  const absentCount  = absentIds.length;
  const presentCount = total - absentCount;
  const pct          = total > 0 ? Math.round((presentCount / total) * 100) : 100;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('session-stat-total',   total);
  set('session-stat-present', presentCount);
  set('session-stat-absent',  absentCount);
  set('session-stat-pct',     pct + '%');

  // Listas
  const lateIds         = session.lateStudents || [];
  const absentStudents  = state.students.filter(s => absentIds.includes(s.id));
  const lateStudents    = state.students.filter(s => lateIds.includes(s.id));
  const presentStudents = state.students.filter(s => !absentIds.includes(s.id) && !lateIds.includes(s.id));

  // Número de lista: posición en la lista completa ordenada alfabéticamente (una sola vez)
  const numById = {};
  [...state.students]
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }))
    .forEach((s, idx) => { numById[s.id] = idx + 1; });

  renderDetailPersonList('detail-absent-list',  absentStudents,  'absent',  numById);
  renderDetailPersonList('detail-late-list',    lateStudents,    'late',    numById);
  renderDetailPersonList('detail-present-list', presentStudents, 'present', numById);

  // Ocultar secciones vacías
  document.getElementById('detail-absent-section')
    ?.classList.toggle('hidden', absentStudents.length === 0);
  document.getElementById('detail-late-section')
    ?.classList.toggle('hidden', lateStudents.length === 0);
}

function renderDetailPersonList(containerId, students, kind, numById = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (students.length === 0) {
    el.innerHTML = `<div style="padding:12px 14px;font-size:13px;color:var(--c-text-2);">
      ${kind === 'absent' ? 'Ningún alumno ausente 🎉' : 'Sin presentes'}
    </div>`;
    return;
  }

  el.innerHTML = students.map((s, i) => {
    const bg    = AVATAR_COLORS[i % AVATAR_COLORS.length];
    const badge = kind === 'absent'
      ? `<span class="aa-badge absent">✗ Ausente</span>`
      : kind === 'late'
        ? `<span class="aa-badge" style="background:#FEF3C7;color:#92400E;">⏰ Tarde</span>`
        : `<span class="aa-badge present">✓ Presente</span>`;
    const num = numById[s.id] ? `<b style="min-width:24px;text-align:right;color:var(--c-text-2);font-size:13px;">${numById[s.id]}.</b>` : '';
    return `
      <div class="aa-srow" style="cursor:default;">
        ${num}
        <div class="aa-avatar sm" style="background:${bg}">${initials(s.name)}</div>
        <span class="srow-name">${esc(s.name)}</span>
        ${badge}
      </div>`;
  }).join('');
}

// ════════════════════════════════════
// SALONES CRUD
// ════════════════════════════════════
let editingClassroomId = null;
let selectedColorIdx   = 0; // color elegido en el formulario

// Dibuja las muestras de color y marca la seleccionada.
function renderColorPicker(selected) {
  selectedColorIdx = selected;
  const box = document.getElementById('classroom-color-picker');
  if (!box) return;
  box.innerHTML = CARD_COLORS.map((col, i) => `
    <button type="button"
            class="color-swatch${i === selectedColorIdx ? ' selected' : ''}"
            style="background:${col.stripe}"
            onclick="pickClassroomColor(${i})"
            title="Color ${i + 1}"></button>`).join('');
}

function pickClassroomColor(i) {
  selectedColorIdx = i;
  document.querySelectorAll('#classroom-color-picker .color-swatch')
    .forEach((el, idx) => el.classList.toggle('selected', idx === i));
}

function openAddClassroom() {
  editingClassroomId = null;
  document.getElementById('modal-classroom-title').textContent = 'Nuevo Salón';
  document.getElementById('classroom-name').value    = '';
  document.getElementById('classroom-subject').value = '';
  document.getElementById('classroom-grade').value   = '';
  // Color automático por defecto: el siguiente según cuántos salones hay.
  renderColorPicker(state.classrooms.length % CARD_COLORS.length);
  openModal('modal-classroom');
  setTimeout(() => document.getElementById('classroom-name').focus(), 320);
}

function openEditClassroom() {
  const c = state.currentClassroom;
  if (!c) return;
  editingClassroomId = c.id;
  document.getElementById('modal-classroom-title').textContent = 'Editar Salón';
  document.getElementById('classroom-name').value    = c.name    || '';
  document.getElementById('classroom-subject').value = c.subject || '';
  document.getElementById('classroom-grade').value   = c.grade   || '';
  const idx = Number.isInteger(c.colorIdx) ? c.colorIdx
            : (state.classrooms.findIndex(x => x.id === c.id) % CARD_COLORS.length);
  renderColorPicker(idx >= 0 ? idx : 0);
  openModal('modal-classroom');
}

async function saveClassroom() {
  const name = document.getElementById('classroom-name').value.trim();
  if (!name) { showToast('Escribe el nombre del salón'); return; }

  const data = {
    name,
    subject: document.getElementById('classroom-subject').value.trim(),
    grade:   document.getElementById('classroom-grade').value.trim(),
    colorIdx: selectedColorIdx,
  };

  try {
    if (editingClassroomId) {
      await db.collection('classrooms').doc(editingClassroomId).update(data);
      // Actualizar classroom actual si es el mismo
      if (state.currentClassroom?.id === editingClassroomId) {
        state.currentClassroom = { ...state.currentClassroom, ...data };
        renderClassroomDetailHeader(state.currentClassroom);
      }
      showToast('Salón actualizado ✓');
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      // F7: asociar salón al docente actual
      if (auth?.currentUser?.uid) data.ownerId = auth.currentUser.uid;
      await db.collection('classrooms').add(data);
      showToast('Salón creado ✓');
    }
    closeModal('modal-classroom');
  } catch (e) {
    console.error(e);
    showToast('Error al guardar');
  }
}

// ════════════════════════════════════
// ELIMINAR SALÓN
// ════════════════════════════════════
// Eliminar desde la lista de salones (botón 🗑️ en cada tarjeta).
// `event` permite frenar la propagación para que no se abra el salón al borrar.
// El renombrar y eliminar de cada sección viven dentro del salón:
// botones ✏️ (openEditClassroom) y 🗑️ (confirmDeleteClassroom) en su cabecera.

// Acepta un salón opcional; si no se pasa, usa el salón abierto (vista detalle).
function confirmDeleteClassroom(classroom) {
  const c = classroom || state.currentClassroom;
  if (!c) return;
  const fromDetail = state.currentClassroom?.id === c.id;
  showConfirm(
    'Eliminar Salón',
    `¿Eliminar "${c.name}" y todos sus datos?\nEsta acción no se puede deshacer.`,
    async () => {
      try {
        const classRef = db.collection('classrooms').doc(c.id);

        // Borrar sub-colección students
        const studs = await classRef.collection('students').get();
        const batch1 = db.batch();
        studs.docs.forEach(d => batch1.delete(d.ref));
        if (!studs.empty) await batch1.commit();

        // Borrar sub-colección sessions
        const sess = await classRef.collection('sessions').get();
        const batch2 = db.batch();
        sess.docs.forEach(d => batch2.delete(d.ref));
        if (!sess.empty) await batch2.commit();

        // Borrar el salón
        await classRef.delete();

        // Limpiar caché local
        if (state._lastSessions) delete state._lastSessions[c.id];
        if (state.currentClassroom?.id === c.id) state.currentClassroom = null;

        closeModal('modal-confirm');
        showToast('Salón eliminado');
        // Si lo borramos desde el detalle, volver al inicio; si no, quedarse.
        if (fromDetail) navigateTo('home');
      } catch (e) {
        console.error(e);
        showToast('Error al eliminar');
      }
    }
  );
}

// ════════════════════════════════════
// PDF
// ════════════════════════════════════
async function downloadPDF() {
  if (!state.currentClassroom || !state.currentSession) {
    showToast('Sin datos para exportar');
    return;
  }

  const { jsPDF }   = window.jspdf;
  const doc         = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const session     = state.currentSession;
  const classroom   = state.currentClassroom;
  const absentIds   = getAbsentIds(session);
  const lateIds     = session.lateStudents || [];

  const C_PRIMARY = [67, 97, 238];
  const C_AMBER   = [217, 119, 6];
  const C_GREEN   = [5, 150, 105];
  const C_RED     = [220, 38, 38];
  const C_DARK    = [26, 26, 46];
  const C_GRAY    = [138, 138, 154];
  const C_LIGHT   = [244, 245, 247];

  // Generar QR del salón (identifica salón + fecha de la sesión)
  const qrContent = `AsistApp | ${classroom.name}${classroom.subject ? ' · ' + classroom.subject : ''} | ${isoFromTimestamp(session.date)}`;
  const qrDataURL = typeof generateQRDataURL === 'function'
    ? await generateQRDataURL(qrContent, 180) : null;

  // Header azul
  doc.setFillColor(...C_PRIMARY);
  doc.rect(0, 0, 210, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22); doc.setFont('helvetica', 'bold');
  doc.text('AsistApp', 14, 13);
  doc.setFontSize(10); doc.setFont('helvetica', 'normal');
  doc.text('Registro de Asistencia', 14, 21);
  doc.setFontSize(9);
  doc.text(formatDateLong(session.date), 196, 18, { align: 'right' });

  // QR del salón en el header (esquina superior derecha)
  if (qrDataURL) {
    doc.addImage(qrDataURL, 'PNG', 184, 2, 22, 22);
    doc.setFontSize(6); doc.setTextColor(255, 255, 255);
    doc.text('QR Salón', 195, 27, { align: 'center' });
  }

  // Nombre salón
  doc.setTextColor(...C_DARK);
  doc.setFontSize(18); doc.setFont('helvetica', 'bold');
  doc.text(classroom.name, 14, 44);
  const sub = [classroom.subject, classroom.grade].filter(Boolean).join(' · ');
  if (sub) {
    doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C_GRAY);
    doc.text(sub, 14, 51);
  }

  let y = 58;
  // Tema
  doc.setFillColor(...C_LIGHT);
  doc.roundedRect(14, y, 182, 18, 2, 2, 'F');
  doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C_GRAY);
  doc.text('TEMA DE LA CLASE', 19, y + 6);
  doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C_DARK);
  doc.text(session.topic || 'Sin tema', 19, y + 13);
  y += 22;

  if (session.notes) {
    doc.setFillColor(...C_LIGHT);
    doc.roundedRect(14, y, 182, 16, 2, 2, 'F');
    doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(...C_GRAY);
    doc.text('OBSERVACIONES', 19, y + 6);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C_DARK);
    doc.text(doc.splitTextToSize(session.notes, 172)[0], 19, y + 12);
    y += 20;
  }
  y += 4;

  // Stats
  const total        = session.totalStudents || state.students.length;
  const absentCount  = absentIds.length;
  const presentCount = total - absentCount;
  const pct          = total > 0 ? Math.round((presentCount / total) * 100) : 100;

  const stats = [
    { label: 'Total',      value: total,        color: C_PRIMARY },
    { label: 'Presentes',  value: presentCount, color: C_GREEN },
  ];
  if (lateIds.length) stats.push({ label: 'Tarde', value: lateIds.length, color: C_AMBER });
  stats.push(
    { label: 'Ausentes',   value: absentCount,  color: C_RED },
    { label: 'Asistencia', value: pct + '%',    color: C_PRIMARY },
  );
  const boxW = (182 - (stats.length - 1) * 2.7) / stats.length;
  stats.forEach((st, i) => {
    const x = 14 + i * (boxW + 2.7);
    doc.setFillColor(...st.color);
    doc.roundedRect(x, y, boxW, 18, 3, 3, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text(String(st.value), x + boxW / 2, y + 10, { align: 'center' });
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text(st.label, x + boxW / 2, y + 16, { align: 'center' });
  });
  y += 26;

  // Tabla
  doc.autoTable({
    head: [['#', 'Estudiante', 'Estado']],
    body: state.students.map((s, i) => [i + 1, s.name,
      absentIds.includes(s.id) ? 'Ausente' : lateIds.includes(s.id) ? 'Tarde' : 'Presente']),
    startY: y,
    margin: { left: 14, right: 14 },
    headStyles: { fillColor: C_PRIMARY, textColor: [255,255,255], fontSize: 10, fontStyle: 'bold' },
    bodyStyles: { fontSize: 10, textColor: C_DARK },
    alternateRowStyles: { fillColor: C_LIGHT },
    didParseCell(data) {
      if (data.section === 'body' && data.column.index === 2) {
        data.cell.styles.textColor = data.cell.raw === 'Ausente' ? C_RED
          : data.cell.raw === 'Tarde' ? C_AMBER : C_GREEN;
        data.cell.styles.fontStyle = 'bold';
      }
    },
    columnStyles: { 0: { cellWidth: 12, halign: 'center' }, 2: { cellWidth: 32, halign: 'center' } },
  });

  // Pie de página mejorado
  const pages = doc.internal.getNumberOfPages();
  const now   = new Date().toLocaleDateString('es-ES');
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const y = 287;
    doc.setDrawColor(...C_GRAY); doc.setLineWidth(0.3);
    doc.line(14, y - 4, 196, y - 4);
    doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(...C_GRAY);
    doc.text(`AsistApp · Generado el ${now} · Pág ${p}/${pages}`, 105, y, { align: 'center' });
  }
  // Firma del docente en la última página
  doc.setPage(pages);
  const sigY = (doc.previousAutoTable?.finalY || 240) + 16;
  if (sigY < 260) {
    doc.setFontSize(8.5); doc.setTextColor(...C_GRAY);
    doc.text('Firma del docente:', 14, sigY);
    doc.setDrawColor(...C_GRAY); doc.setLineWidth(0.3);
    doc.line(14, sigY + 10, 88, sigY + 10);
    doc.text('Sello del plantel:', 114, sigY);
    doc.line(114, sigY + 10, 196, sigY + 10);
  }

  doc.save(`Asistencia_${classroom.name.replace(/[^a-z0-9]/gi,'_')}_${isoFromTimestamp(session.date)}.pdf`);
  showToast('PDF descargado ✓');
}

// ════════════════════════════════════
// MODALES
// ════════════════════════════════════
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

// Cerrar al tocar el overlay
document.querySelectorAll('.modal-overlay, .confirm-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

function showConfirm(title, message, onConfirm, okLabel = 'Eliminar') {
  document.getElementById('confirm-title').textContent   = title;
  document.getElementById('confirm-message').textContent = message;
  const btn = document.getElementById('confirm-ok-btn');
  if (btn) { btn.onclick = onConfirm; btn.textContent = okLabel; }
  openModal('modal-confirm');
}

// ════════════════════════════════════
// TOAST
// ════════════════════════════════════
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// Marca un campo obligatorio en rojo, lo enfoca y muestra el motivo
function markFieldInvalid(fieldId, msg) {
  const el = document.getElementById(fieldId);
  if (el) {
    el.style.outline = '2px solid #EF4444';
    el.style.outlineOffset = '1px';
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    try { el.focus({ preventScroll: true }); } catch {}
    setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 3000);
  }
  showToast(msg);
}

// ════════════════════════════════════
// INASISTENCIAS PARA EL DIARIO DE CLASES
// Devuelve los NÚMEROS DE LISTA de los ausentes (posición del alumno
// en la lista ordenada por nombre, igual que la planilla impresa).
// ════════════════════════════════════
function buildAbsentNumbers(absentIds) {
  const ids = new Set(absentIds || []);
  // Ordenar igual que la planilla (alfabético por apellido/nombre)
  const sorted = [...state.students].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }));
  const nums = [];
  sorted.forEach((st, idx) => {
    if (ids.has(st.id)) nums.push(idx + 1);
  });
  return nums; // ya en orden ascendente
}

let _lastInasistencias = '';
function showInasistenciasModal(absentIds) {
  const nums = buildAbsentNumbers(absentIds);
  _lastInasistencias = nums.join('-');
  const box = document.getElementById('inas-numbers');
  if (box) box.textContent = nums.length ? _lastInasistencias : 'Sin inasistencias 🎉';
  openModal('modal-inasistencias');
}

function copyInasistencias() {
  if (!_lastInasistencias) { showToast('No hay inasistencias que copiar'); return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(_lastInasistencias)
      .then(() => showToast('Copiado ✓'))
      .catch(() => showToast('No se pudo copiar'));
  } else {
    showToast('Copia manual: ' + _lastInasistencias);
  }
}

// ════════════════════════════════════
// RESPALDO — exportar / restaurar todos los datos
// ════════════════════════════════════

// Descarga un archivo .json con todos los salones, estudiantes y sesiones.
// Queda guardado en el dispositivo del usuario (Descargas).
async function exportBackup() {
  try {
    showToast('Generando respaldo…');
    const uid = auth?.currentUser?.uid || null;
    let query = db.collection('classrooms');
    if (uid) query = query.where('ownerId', '==', uid);
    const snap = await query.get();

    const classrooms = [];
    for (const doc of snap.docs) {
      const ref = db.collection('classrooms').doc(doc.id);
      const [studSnap, sessSnap] = await Promise.all([
        ref.collection('students').get(),
        ref.collection('sessions').get(),
      ]);
      classrooms.push({
        id:       doc.id,
        data:     doc.data(),
        students: studSnap.docs.map(d => ({ id: d.id, data: d.data() })),
        sessions: sessSnap.docs.map(d => ({ id: d.id, data: d.data() })),
      });
    }

    const backup = {
      app:        'AsistApp',
      version:    1,
      exportedAt: new Date().toISOString(),
      ownerId:    uid,
      classrooms,
    };

    const stamp = new Date().toISOString().slice(0, 10);
    const blob  = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url;
    a.download = `asistapp-respaldo-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    try { localStorage.setItem('asistapp_last_backup', Date.now().toString()); } catch {}

    const total = classrooms.reduce((n, c) => n + c.students.length, 0);
    showToast(`Respaldo listo: ${classrooms.length} salones, ${total} estudiantes ✓`);
  } catch (e) {
    console.error('[Respaldo] Error al exportar:', e);
    showToast('No se pudo generar el respaldo');
  }
}

// Recordatorio: si pasaron 7+ días desde el último respaldo (o nunca), avisa.
const BACKUP_REMINDER_DAYS = 7;
function checkBackupReminder() {
  // No molestar si no hay salones que respaldar todavía
  if (!state.classrooms || state.classrooms.length === 0) return;

  let last = 0;
  try { last = parseInt(localStorage.getItem('asistapp_last_backup') || '0', 10) || 0; } catch {}

  const dias = last ? (Date.now() - last) / 86400000 : Infinity;
  if (dias < BACKUP_REMINDER_DAYS) return;

  const msg = last
    ? `Hace ${Math.floor(dias)} días que no descargas un respaldo.\n\n¿Descargar uno ahora?`
    : `Aún no has descargado ningún respaldo de tus datos.\n\n¿Descargar uno ahora para tenerlo seguro?`;
  if (confirm(msg)) {
    exportBackup();
  } else {
    // Posponer 1 día para no insistir cada vez que abre la app
    try { localStorage.setItem('asistapp_last_backup', (Date.now() - (BACKUP_REMINDER_DAYS - 1) * 86400000).toString()); } catch {}
  }
}

// Lee un archivo .json y restaura los datos en Firestore.
// Crea salones nuevos (no sobrescribe los existentes) para evitar pérdidas.
function importBackup(input) {
  const file = input.files && input.files[0];
  input.value = ''; // permitir volver a elegir el mismo archivo
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    let backup;
    try {
      backup = JSON.parse(reader.result);
    } catch {
      showToast('Archivo inválido (no es JSON)');
      return;
    }
    if (!backup || backup.app !== 'AsistApp' || !Array.isArray(backup.classrooms)) {
      showToast('Este archivo no es un respaldo de AsistApp');
      return;
    }

    const totalSal = backup.classrooms.length;
    const totalEst = backup.classrooms.reduce((n, c) => n + (c.students?.length || 0), 0);
    const ok = confirm(
      `Restaurar respaldo del ${(backup.exportedAt || '').slice(0, 10)}?\n\n` +
      `Se agregarán ${totalSal} salones y ${totalEst} estudiantes como copias nuevas.\n` +
      `Tus datos actuales NO se borran.`
    );
    if (!ok) return;

    try {
      showToast('Restaurando…');
      const uid = auth?.currentUser?.uid || null;

      // Al exportar, los Timestamps de Firestore se serializan como
      // {seconds, nanoseconds}. Hay que reconstruirlos al restaurar,
      // si no las fechas quedan como mapas y rompen el orden/formato.
      const reviveTimestamps = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const out = Array.isArray(obj) ? [] : {};
        for (const [k, v] of Object.entries(obj)) {
          if (v && typeof v === 'object' && typeof v.seconds === 'number'
              && typeof v.nanoseconds === 'number' && Object.keys(v).length === 2) {
            out[k] = new firebase.firestore.Timestamp(v.seconds, v.nanoseconds);
          } else if (v && typeof v === 'object') {
            out[k] = reviveTimestamps(v);
          } else {
            out[k] = v;
          }
        }
        return out;
      };

      let restored = 0;
      for (const c of backup.classrooms) {
        const cData = reviveTimestamps({ ...(c.data || {}) });
        if (uid) cData.ownerId = uid;
        const newRef = await db.collection('classrooms').add(cData);

        // Estudiantes y sesiones en lotes
        const writeAll = async (items, subName) => {
          for (let i = 0; i < (items?.length || 0); i += 400) {
            const batch = db.batch();
            items.slice(i, i + 400).forEach(it => {
              batch.set(newRef.collection(subName).doc(), reviveTimestamps(it.data || {}));
            });
            await batch.commit();
          }
        };
        await writeAll(c.students, 'students');
        await writeAll(c.sessions, 'sessions');
        restored++;
      }

      showToast(`Restaurados ${restored} salones ✓`);
      navigateTo('home');
    } catch (e) {
      console.error('[Respaldo] Error al restaurar:', e);
      showToast('No se pudo restaurar el respaldo');
    }
  };
  reader.onerror = () => showToast('No se pudo leer el archivo');
  reader.readAsText(file);
}

// ════════════════════════════════════
// HELPERS
// ════════════════════════════════════
function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tsToDate(ts) {
  if (!ts) return new Date();
  if (ts.toDate) return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return new Date(ts);
}

function formatDate(ts) {
  const d = tsToDate(ts);
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatDateLong(ts) {
  const d = tsToDate(ts);
  const s = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isoFromTimestamp(ts) {
  return toLocalISO(tsToDate(ts));
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

// ════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════
async function loadDashboard() {
  if (!db || state.classrooms.length === 0) {
    renderDashboardEmpty();
    return;
  }

  const today   = todayISO();
  const now     = new Date();
  const thisMonth = now.getMonth();
  const thisYear  = now.getFullYear();

  const allRecentSessions = [];
  const chartData         = [];
  const alertStudents     = [];

  let todayTotal   = 0;
  let todayPresent = 0;
  let todayAbsent  = 0;
  let todayClasses = 0;

  // Cargar sesiones y alumnos de cada salón en paralelo
  await Promise.all(state.classrooms.map(async c => {
    try {
      const [studSnap, sessSnap] = await Promise.all([
        db.collection('classrooms').doc(c.id).collection('students').get(),
        db.collection('classrooms').doc(c.id).collection('sessions')
          .orderBy('date', 'desc').limit(20).get(),
      ]);

      const totalStudents = studSnap.size;
      const sessions = sessSnap.docs.map(d => ({ id: d.id, classroomId: c.id,
        classroomName: c.name, totalStudents, ...d.data() }));

      // — Stats de hoy —
      const todaySess = sessions.find(s => isoFromTimestamp(s.date) === today);
      if (todaySess) {
        const absent  = getAbsentIds(todaySess).length;
        const total   = todaySess.totalStudents || totalStudents;
        todayClasses++;
        todayTotal   += total;
        todayAbsent  += absent;
        todayPresent += total - absent;
      }

      // — Recientes (para el widget) —
      allRecentSessions.push(...sessions.slice(0, 4));

      // — Chart: % asistencia del mes actual —
      const monthSess = sessions.filter(s => {
        const d = tsToDate(s.date);
        return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
      });
      if (monthSess.length > 0) {
        let mPresent = 0, mTotal = 0;
        monthSess.forEach(s => {
          const absent = getAbsentIds(s).length;
          const tot    = s.totalStudents || totalStudents;
          mPresent += tot - absent;
          mTotal   += tot;
        });
        const pct = mTotal > 0 ? Math.round(mPresent / mTotal * 100) : null;
        chartData.push({ name: c.name, pct, sessions: monthSess.length });
      }

      // — Alertas: alumnos con N+ ausencias (últimas 10 clases) —
      const absentCounts = {};
      sessions.slice(0, 10).forEach(s => {
        getAbsentIds(s).forEach(sid => {
          absentCounts[sid] = (absentCounts[sid] || 0) + 1;
        });
      });
      Object.entries(absentCounts).forEach(([sid, count]) => {
        if (count >= alertThreshold) {
          const docStudent = studSnap.docs.find(d => d.id === sid);
          if (docStudent) {
            alertStudents.push({
              type: 'student',
              name: docStudent.data().name,
              count,
              classroomName: c.name,
            });
          }
        }
      });

      // — Alerta: salón sin sesión en los últimos 7 días —
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const lastSess = sessions[0];
      if (sessions.length > 0 && tsToDate(lastSess.date) < sevenDaysAgo) {
        const daysAgo = Math.floor((Date.now() - tsToDate(lastSess.date)) / 86400000);
        alertStudents.push({
          type: 'classroom',
          name: c.name,
          daysAgo,
          classroomName: c.name,
        });
      } else if (sessions.length === 0 && totalStudents > 0) {
        alertStudents.push({
          type: 'classroom',
          name: c.name,
          daysAgo: null,
          classroomName: c.name,
        });
      }
    } catch (e) { console.warn('Dashboard error en', c.name, e); }
  }));

  // Ordenar recientes por fecha desc
  allRecentSessions.sort((a, b) => tsToDate(b.date) - tsToDate(a.date));
  alertStudents.sort((a, b) => b.count - a.count);

  // — Renderizar —
  renderDashboardStats({ todayClasses, todayTotal, todayPresent, todayAbsent });
  drawAttendanceChart(chartData);
  renderRecentSessions(allRecentSessions.slice(0, 5));
  renderAlerts(alertStudents.slice(0, 6));

  // F6: Actualizar badge con alertas de Firebase en background
  loadAllAlerts().catch(() => {});
}

function renderDashboardEmpty() {
  ['dash-today-ok','dash-pct','dash-absent'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  const canvas = document.getElementById('dash-chart');
  if (canvas) { canvas.height = 0; }
  document.getElementById('dash-chart-empty')?.classList.remove('hidden');
  document.getElementById('dash-recent-list').innerHTML = '';
  document.getElementById('dash-recent-empty')?.classList.remove('hidden');
  document.getElementById('dash-alerts-section').style.display = 'none';
}

function renderDashboardStats({ todayClasses, todayTotal, todayPresent, todayAbsent }) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const pct = todayTotal > 0 ? Math.round(todayPresent / todayTotal * 100) + '%' : '—';
  set('dash-today-ok', todayClasses > 0 ? todayClasses : '0');
  set('dash-pct',      pct);
  set('dash-absent',   todayAbsent > 0 ? todayAbsent : todayClasses > 0 ? '0' : '—');
}

// ── Canvas chart ─────────────────────────────────────────────
function drawAttendanceChart(data) {
  const canvas    = document.getElementById('dash-chart');
  const emptyMsg  = document.getElementById('dash-chart-empty');
  const monthLabel = document.getElementById('dash-chart-month');
  if (!canvas) return;

  // Etiqueta del mes
  if (monthLabel) {
    const m = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    monthLabel.textContent = m.charAt(0).toUpperCase() + m.slice(1);
  }

  if (data.length === 0) {
    canvas.style.display = 'none';
    emptyMsg?.classList.remove('hidden');
    return;
  }
  canvas.style.display = 'block';
  emptyMsg?.classList.add('hidden');

  const ROW_H    = 54;
  const PAD_L    = 118;
  const PAD_R    = 52;
  const PAD_V    = 10;
  const BAR_H    = 22;
  const RADIUS   = 6;

  const W = canvas.parentElement?.clientWidth - 32 || 320;
  const H = data.length * ROW_H + PAD_V * 2;
  canvas.width  = W;
  canvas.height = H;

  const ctx    = canvas.getContext('2d');
  const barW   = W - PAD_L - PAD_R;

  ctx.clearRect(0, 0, W, H);

  data.forEach((item, i) => {
    const y    = PAD_V + i * ROW_H;
    const barY = y + (ROW_H - BAR_H) / 2;
    const pct  = item.pct ?? 0;

    // Color según porcentaje
    const color = pct >= 90 ? '#059669' : pct >= 75 ? '#D97706' : '#DC2626';
    const bgClr = pct >= 90 ? '#ECFDF5' : pct >= 75 ? '#FFFBEB' : '#FEF2F2';

    // Barra de fondo
    ctx.fillStyle = bgClr;
    roundRect(ctx, PAD_L, barY, barW, BAR_H, RADIUS);
    ctx.fill();

    // Barra de valor
    const fillW = Math.max(RADIUS * 2, barW * pct / 100);
    ctx.fillStyle = color;
    roundRect(ctx, PAD_L, barY, fillW, BAR_H, RADIUS);
    ctx.fill();

    // Nombre del salón
    ctx.fillStyle = '#1A1A2E';
    ctx.font      = '500 12px Poppins, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const name = item.name.length > 15 ? item.name.slice(0, 14) + '…' : item.name;
    ctx.fillText(name, PAD_L - 10, barY + BAR_H / 2);

    // Porcentaje
    ctx.fillStyle    = color;
    ctx.font         = 'bold 12px Poppins, system-ui, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${pct}%`, PAD_L + fillW + 6, barY + BAR_H / 2);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Recent sessions widget ───────────────────────────────────
function renderRecentSessions(sessions) {
  const container = document.getElementById('dash-recent-list');
  const empty     = document.getElementById('dash-recent-empty');
  if (!container) return;

  if (sessions.length === 0) {
    container.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');

  container.innerHTML = sessions.map(s => {
    const absentCount = (s.absentStudents || []).length;
    const total       = s.totalStudents || 0;
    const pct         = total > 0 ? Math.round((total - absentCount) / total * 100) : 100;
    const color       = pct >= 90 ? '#059669' : pct >= 75 ? '#D97706' : '#DC2626';
    const badgeClass  = absentCount > 0 ? 'absent' : 'present';
    const badgeTxt    = absentCount > 0
      ? `✗ ${absentCount} aus.`
      : '✓ Completa';

    return `
      <div class="dash-recent-item" onclick="openRecentSession('${s.classroomId}','${s.id}')">
        <div class="dash-recent-dot" style="background:${color}"></div>
        <div class="dash-recent-info">
          <div class="dash-recent-cls">${esc(s.classroomName)}</div>
          <div class="dash-recent-topic">${esc(s.topic || 'Sin tema')}</div>
          <div class="dash-recent-date">${formatDate(s.date)}</div>
        </div>
        <span class="aa-badge ${badgeClass} dash-recent-badge">${badgeTxt}</span>
      </div>`;
  }).join('');
}

function openRecentSession(classroomId, sessionId) {
  const classroom = state.classrooms.find(c => c.id === classroomId);
  if (!classroom) { showToast('Cargando...'); return; }
  // Necesitamos cargar el salón y luego la sesión
  state.currentClassroom = classroom;
  loadStudents(classroomId).then(() => {
    loadSessions(classroomId).then(() => {
      const session = state.sessions.find(s => s.id === sessionId);
      if (session) {
        const backBtn = document.getElementById('session-back-btn');
        if (backBtn) backBtn.onclick = () => navigateTo('classroom-detail', classroom);
        const clsEl = document.getElementById('session-detail-classroom');
        if (clsEl) clsEl.textContent = classroom.name;
        navigateTo('session-detail', session);
      }
    });
  });
}

// ── Alerts widget ────────────────────────────────────────────
function renderAlerts(alerts) {
  const section   = document.getElementById('dash-alerts-section');
  const container = document.getElementById('dash-alerts-list');
  const subEl     = document.getElementById('dash-alerts-sub');
  if (!section || !container) return;

  if (alerts.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  if (subEl) subEl.textContent = `${alerts.length} alerta${alerts.length !== 1 ? 's' : ''}`;

  container.innerHTML = alerts.map(a => {
    if (a.type === 'student') {
      return `
        <div class="dash-alert-item">
          <div class="dash-alert-avatar">${initials(a.name)}</div>
          <div class="dash-alert-info">
            <div class="dash-alert-name">${esc(a.name)}</div>
            <div class="dash-alert-cls">👥 ${esc(a.classroomName)}</div>
          </div>
          <div class="dash-alert-count">${a.count} ausencias</div>
        </div>`;
    } else {
      const txt = a.daysAgo ? `Sin clase hace ${a.daysAgo} días` : 'Sin clases registradas';
      return `
        <div class="dash-alert-item" style="background:var(--c-yellow-bg);border-color:#FDE68A;">
          <div class="dash-alert-avatar" style="background:var(--c-yellow);">🏫</div>
          <div class="dash-alert-info">
            <div class="dash-alert-name">${esc(a.name)}</div>
            <div class="dash-alert-cls">${txt}</div>
          </div>
        </div>`;
    }
  }).join('');
}

// ════════════════════════════════════
// PERFIL DE ESTUDIANTE — F3
// ════════════════════════════════════

// Helpers de compatibilidad (formato antiguo = string[], nuevo = obj[])
function getAbsentIds(session) {
  return (session.absentStudents || []).map(a =>
    typeof a === 'string' ? a : a.studentId
  );
}
function getJustification(session, studentId) {
  const entry = (session.absentStudents || [])
    .find(a => (typeof a === 'string' ? a : a.studentId) === studentId);
  return typeof entry === 'object' ? (entry.justification || null) : null;
}

// Estado del perfil actual
const profileState = {
  studentId:    null,
  classroomId:  null,
  sessions:     [],
  justifSession: null,
  period:       'year',  // 'month' | 'trimester' | 'year'
};

function openStudentProfile(studentId) {
  if (!state.currentClassroom) return;
  profileState.studentId   = studentId;
  profileState.classroomId = state.currentClassroom.id;

  // Botón back vuelve al detalle del salón
  const backBtn = document.getElementById('profile-back-btn');
  if (backBtn) backBtn.onclick = () => navigateTo('classroom-detail', state.currentClassroom);

  navigateTo('student-profile');
}

async function loadStudentProfile() {
  const { studentId, classroomId } = profileState;
  if (!studentId || !classroomId || !db) return;

  // Datos del estudiante
  const student = state.students.find(s => s.id === studentId);
  const classroom = state.currentClassroom;

  // Header
  const avatarEl = document.getElementById('profile-avatar-lg');
  const nameEl   = document.getElementById('profile-student-name');
  const clsEl    = document.getElementById('profile-classroom-label');
  if (student) {
    const idx = state.students.findIndex(s => s.id === studentId);
    const bg  = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    if (avatarEl) { avatarEl.textContent = initials(student.name); avatarEl.style.background = bg; }
    if (nameEl)   nameEl.textContent   = student.name;
    if (clsEl)    clsEl.textContent    = [classroom?.name, classroom?.subject].filter(Boolean).join(' · ');
  }

  // Cargar TODAS las sesiones del salón
  try {
    const snap = await db.collection('classrooms').doc(classroomId)
      .collection('sessions').orderBy('date', 'desc').get();
    profileState.sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(e);
    showToast('Error cargando historial');
    return;
  }

  // Resetear segmented control al año
  profileState.period = 'year';
  ['month','trimester','year','custom'].forEach(p => {
    document.getElementById(`pf-seg-${p}`)?.classList.toggle('active', p === 'year');
  });
  document.getElementById('pf-custom-range')?.classList.add('hidden');

  const filtered = filterSessionsByPeriod(profileState.sessions, 'year');
  const stats    = calcAttendanceStats(profileState.sessions, filtered, studentId);
  renderProfileStats(stats, 'year');
  renderAttendanceCalendar(profileState.sessions, studentId);
  renderTrendChart(profileState.sessions, studentId);
  renderAbsenceTimeline(filtered, studentId);
}

// ── Filtro de periodo ────────────────────────────────────────
function switchProfilePeriod(period) {
  profileState.period = period;

  // Actualizar segmented control
  ['month','trimester','year','custom'].forEach(p => {
    document.getElementById(`pf-seg-${p}`)?.classList.toggle('active', p === period);
  });

  // Mostrar u ocultar el picker de rango personalizado
  const rangeEl = document.getElementById('pf-custom-range');
  if (rangeEl) rangeEl.classList.toggle('hidden', period !== 'custom');

  // Si se activa Rango, inicializar fechas por defecto y esperar Aplicar
  if (period === 'custom') {
    const fromEl = document.getElementById('pf-range-from');
    const toEl   = document.getElementById('pf-range-to');
    if (fromEl && !fromEl.value) {
      // Default: primer día del mes actual
      const now = new Date();
      fromEl.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    }
    if (toEl && !toEl.value) {
      toEl.value = todayISO();
    }
    return; // No aplicar hasta que el usuario toque "Aplicar"
  }

  const { sessions, studentId } = profileState;
  const filtered = filterSessionsByPeriod(sessions, period);
  const stats    = calcAttendanceStats(sessions, filtered, studentId);
  renderProfileStats(stats, period);
  renderAbsenceTimeline(filtered, studentId);
}

// Aplicar rango de fechas personalizado
function applyCustomRange() {
  const fromISO = document.getElementById('pf-range-from')?.value;
  const toISO   = document.getElementById('pf-range-to')?.value;

  if (!fromISO || !toISO) { showToast('Selecciona fecha de inicio y fin'); return; }
  if (fromISO > toISO)    { showToast('La fecha de inicio debe ser anterior al fin'); return; }

  profileState.customFrom = fromISO;
  profileState.customTo   = toISO;

  const { sessions, studentId } = profileState;
  const filtered = filterSessionsByPeriod(sessions, 'custom');
  const stats    = calcAttendanceStats(sessions, filtered, studentId);

  const from = new Date(fromISO + 'T00:00:00');
  const to   = new Date(toISO   + 'T00:00:00');
  const label = `${from.toLocaleDateString('es-ES',{day:'numeric',month:'short'})} – ${to.toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})}`;

  renderProfileStats(stats, 'custom', label);
  renderAbsenceTimeline(filtered, studentId);
  showToast(`Mostrando ${filtered.length} clase${filtered.length !== 1 ? 's' : ''} en el rango`);
}

function filterSessionsByPeriod(sessions, period) {
  const now = new Date();
  return sessions.filter(s => {
    const d = tsToDate(s.date);
    if (period === 'month') {
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }
    if (period === 'trimester') {
      const cutoff = new Date(now);
      cutoff.setMonth(now.getMonth() - 3);
      return d >= cutoff;
    }
    if (period === 'custom') {
      const from = profileState.customFrom ? new Date(profileState.customFrom + 'T00:00:00') : null;
      const to   = profileState.customTo   ? new Date(profileState.customTo   + 'T23:59:59') : null;
      if (from && d < from) return false;
      if (to   && d > to  ) return false;
      return true;
    }
    // year
    return d.getFullYear() === now.getFullYear();
  });
}

function calcAttendanceStats(allSessions, filteredSessions, studentId) {
  // Stats del periodo filtrado
  let periodSess   = filteredSessions.length;
  let periodAbsent = 0;
  filteredSessions.forEach(s => {
    if (getAbsentIds(s).includes(studentId)) periodAbsent++;
  });

  // Total histórico de ausencias
  let totalAbsent = 0;
  let streak = 0, streakActive = true;

  for (const s of allSessions) { // ya ordenadas newest first
    const absent = getAbsentIds(s).includes(studentId);
    if (absent) totalAbsent++;
    if (streakActive) {
      if (absent) streakActive = false;
      else streak++;
    }
  }

  const pct = periodSess > 0
    ? Math.round(((periodSess - periodAbsent) / periodSess) * 100) + '%'
    : '—';

  return { pct, periodAbsent, totalAbsent, streak };
}

function renderProfileStats({ pct, periodAbsent, totalAbsent, streak }, period, customLabel) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const labels = { month: 'Este mes', trimester: 'Trimestre', year: 'Este año', custom: customLabel || 'Rango' };

  set('profile-pct-period',    pct);
  set('profile-absent-period', periodAbsent);
  set('profile-total-absent',  totalAbsent);
  set('profile-streak',        streak > 0 ? streak : '0');

  const labEl = document.getElementById('profile-pct-lab');
  if (labEl) labEl.textContent = labels[period] || 'Periodo';
  const absLabEl = document.getElementById('profile-absent-lab');
  if (absLabEl) absLabEl.textContent = `Aus. ${(labels[period] || '').toLowerCase()}`.trim();

  const streakEl = document.getElementById('profile-streak');
  if (streakEl) streakEl.style.color = streak >= 5 ? 'var(--c-green)' : 'var(--c-text)';
  const pctEl = document.getElementById('profile-pct-period');
  if (pctEl) {
    const num = parseInt(pct);
    pctEl.style.color = isNaN(num) ? 'var(--c-text)'
      : num >= 90 ? 'var(--c-green)' : num >= 75 ? 'var(--c-yellow)' : 'var(--c-red)';
  }
}

// ── Calendario 30 días (6 col × 5 fil) ───────────────────────
function renderAttendanceCalendar(sessions, studentId) {
  const el = document.getElementById('profile-calendar');
  if (!el) return;

  // Mapa fecha ISO → estado
  const dateMap = {};
  sessions.forEach(s => {
    const iso = isoFromTimestamp(s.date);
    dateMap[iso] = getAbsentIds(s).includes(studentId) ? 'absent' : 'present';
  });

  // Últimos 30 días (hoy en la última celda)
  const today = new Date();
  const cells = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso    = toLocalISO(d);
    const status = dateMap[iso] || 'none';
    cells.push({ day: d.getDate(), iso, status });
  }

  el.innerHTML = cells.map(c => {
    const cls = c.status === 'present' ? 'cal-present'
              : c.status === 'absent'  ? 'cal-absent'
              : 'cal-none';
    return `<div class="cal-cell ${cls}" title="${c.iso}">${c.day}</div>`;
  }).join('');
}

// ── Gráfico de tendencia (últimos 6 meses) ────────────────────
function renderTrendChart(sessions, studentId) {
  const canvas  = document.getElementById('profile-trend-chart');
  const emptyEl = document.getElementById('profile-trend-empty');
  if (!canvas) return;

  // Construir los últimos 6 meses
  const now    = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label:   d.toLocaleDateString('es-ES', { month: 'short' }),
      year:    d.getFullYear(),
      month:   d.getMonth(),
      present: 0,
      total:   0,
    });
  }

  sessions.forEach(s => {
    const d      = tsToDate(s.date);
    const bucket = months.find(m => m.year === d.getFullYear() && m.month === d.getMonth());
    if (!bucket) return;
    bucket.total++;
    if (!getAbsentIds(s).includes(studentId)) bucket.present++;
  });

  const hasData = months.some(m => m.total > 0);
  if (!hasData) {
    canvas.style.display = 'none';
    emptyEl?.classList.remove('hidden');
    return;
  }
  canvas.style.display = 'block';
  emptyEl?.classList.add('hidden');

  // Dibujar barras verticales
  const W      = (canvas.parentElement?.clientWidth || 340) - 32;
  const H      = 130;
  const PAD_L  = 28, PAD_R = 8, PAD_T = 20, PAD_B = 24;
  canvas.width  = W;
  canvas.height = H;

  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const barAreaW = W - PAD_L - PAD_R;
  const barW     = barAreaW / months.length;
  const barMaxH  = H - PAD_T - PAD_B;

  months.forEach((m, i) => {
    const x   = PAD_L + i * barW;
    const bw  = barW * 0.6;
    const bx  = x + (barW - bw) / 2;

    // Fondo
    ctx.fillStyle = '#F3F4F6';
    roundRect(ctx, bx, PAD_T, bw, barMaxH, 5);
    ctx.fill();

    if (m.total > 0) {
      const pct   = Math.round(m.present / m.total * 100);
      const color = pct >= 90 ? '#059669' : pct >= 75 ? '#D97706' : '#DC2626';
      const bh    = Math.max(6, barMaxH * pct / 100);

      ctx.fillStyle = color;
      roundRect(ctx, bx, PAD_T + barMaxH - bh, bw, bh, 5);
      ctx.fill();

      // Porcentaje encima
      ctx.fillStyle    = color;
      ctx.font         = 'bold 9px system-ui, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${pct}%`, bx + bw / 2, PAD_T + barMaxH - bh - 2);
    }

    // Etiqueta mes
    ctx.fillStyle    = '#8A8A9A';
    ctx.font         = '9px system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, x + barW / 2, H - PAD_B + 6);
  });

  // Línea base
  ctx.strokeStyle = '#EFEFEF';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T + barMaxH);
  ctx.lineTo(W - PAD_R, PAD_T + barMaxH);
  ctx.stroke();
}

// ── Timeline de ausencias ─────────────────────────────────────
function renderAbsenceTimeline(sessions, studentId) {
  const container = document.getElementById('profile-absence-timeline');
  const emptyEl   = document.getElementById('profile-no-absences');
  const countEl   = document.getElementById('profile-absence-count');
  if (!container) return;

  const absences = sessions.filter(s => getAbsentIds(s).includes(studentId));

  if (countEl) countEl.textContent = absences.length > 0
    ? `${absences.length} ausencia${absences.length !== 1 ? 's' : ''}` : '';

  if (absences.length === 0) {
    container.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  container.innerHTML = absences.map(s => {
    const justif = getJustification(s, studentId);
    const justifHtml = justif
      ? `<div class="timeline-justif">📝 ${esc(justif)}</div>`
      : '';
    return `
      <div class="timeline-item">
        <div class="timeline-dot absent-dot"></div>
        <div class="timeline-body">
          <div class="timeline-date">${formatDateLong(s.date)}</div>
          <div class="timeline-topic">${esc(s.topic || 'Sin tema')}</div>
          ${justifHtml}
          <button class="timeline-justif-btn"
                  onclick="openJustification('${s.id}','${esc(s.topic || '')}','${studentId}')">
            ${justif ? '✏️ Editar justificación' : '+ Agregar justificación'}
          </button>
        </div>
      </div>`;
  }).join('');
}

// ── Justificación de ausencia ─────────────────────────────────
function openJustification(sessionId, topic, studentId) {
  profileState.justifSession = { sessionId, studentId };

  const infoEl = document.getElementById('justif-session-info');
  if (infoEl) infoEl.textContent = `Clase: ${topic || 'Sin tema'}`;

  // Pre-rellenar si ya hay justificación
  const session  = profileState.sessions.find(s => s.id === sessionId);
  const existing = session ? getJustification(session, studentId) : '';
  const textarea = document.getElementById('justif-text');
  if (textarea) textarea.value = existing || '';

  openModal('modal-justification');
  setTimeout(() => textarea?.focus(), 320);
}

async function saveJustification() {
  const { sessionId, studentId } = profileState.justifSession || {};
  if (!sessionId || !studentId || !state.currentClassroom) return;

  const text = document.getElementById('justif-text')?.value.trim() || '';

  try {
    const sessRef = db.collection('classrooms').doc(state.currentClassroom.id)
      .collection('sessions').doc(sessionId);
    const sessDoc = await sessRef.get();
    if (!sessDoc.exists) { showToast('Sesión no encontrada'); return; }

    // Migrar absentStudents al formato objeto y actualizar
    const raw = sessDoc.data().absentStudents || [];
    const updated = raw.map(a => {
      const sid = typeof a === 'string' ? a : a.studentId;
      if (sid === studentId) {
        // OJO: serverTimestamp() NO se permite dentro de arrays en Firestore.
        return { studentId: sid, justification: text,
                 justifiedAt: firebase.firestore.Timestamp.now() };
      }
      return typeof a === 'string' ? { studentId: a } : a;
    });

    await sessRef.update({ absentStudents: updated });

    // Actualizar estado local
    const localSess = profileState.sessions.find(s => s.id === sessionId);
    if (localSess) localSess.absentStudents = updated;

    closeModal('modal-justification');
    showToast('Justificación guardada ✓');
    renderAbsenceTimeline(profileState.sessions, studentId);
  } catch (e) {
    console.error(e);
    showToast('Error al guardar');
  }
}

// ════════════════════════════════════
// SETTINGS (umbral de alertas)
// ════════════════════════════════════
let alertThreshold = 3; // default (últimas 10 sesiones)

// Referencia a la configuración DEL USUARIO actual (antes era un doc
// global compartido entre todos los docentes — fuga de datos).
function settingsRef() {
  const uid = auth?.currentUser?.uid;
  if (!db || !uid) return null;
  return db.collection('users').doc(uid).collection('settings').doc('alertConfig');
}

async function loadSettings() {
  // Intentar desde Firebase (config propia del usuario)
  const ref = settingsRef();
  if (ref) {
    try {
      const doc = await ref.get();
      if (doc.exists) {
        const d = doc.data();
        if (d.absenceThreshold)    alertThreshold    = d.absenceThreshold;
        if (d.monthlyThreshold)    monthlyThreshold  = d.monthlyThreshold;
        if (d.enablePattern   !== undefined) enablePatternAlert   = d.enablePattern;
        if (d.enableClassroom !== undefined) enableClassroomAlert = d.enableClassroom;
        if (d.enableRecovery  !== undefined) enableRecoveryAlert  = d.enableRecovery;
        localStorage.setItem('alertThreshold',    alertThreshold);
        localStorage.setItem('monthlyThreshold',  monthlyThreshold);
        return;
      }
    } catch { /* ignorar */ }
  }
  loadSettingsLocal();
}

// Fallback a localStorage (antes del login o sin conexión)
function loadSettingsLocal() {
  const stored = parseInt(localStorage.getItem('alertThreshold'));
  if (!isNaN(stored) && stored > 0) alertThreshold = stored;
  const storedM = parseInt(localStorage.getItem('monthlyThreshold'));
  if (!isNaN(storedM) && storedM > 0) monthlyThreshold = storedM;
  const lsPattern  = localStorage.getItem('enablePatternAlert');
  const lsClass    = localStorage.getItem('enableClassroomAlert');
  const lsRecovery = localStorage.getItem('enableRecoveryAlert');
  if (lsPattern  !== null) enablePatternAlert  = lsPattern  !== 'false';
  if (lsClass    !== null) enableClassroomAlert = lsClass   !== 'false';
  if (lsRecovery !== null) enableRecoveryAlert = lsRecovery !== 'false';
}

// ════════════════════════════════════
// QR DEL SALÓN (F5)
// ════════════════════════════════════
function openQRModal() {
  const cls = state.currentClassroom;
  if (!cls) return;

  // Actualizar textos
  const nameEl = document.getElementById('qr-modal-name');
  const subEl  = document.getElementById('qr-modal-sub');
  if (nameEl) nameEl.textContent = cls.name;
  if (subEl)  subEl.textContent  = [cls.subject, cls.grade].filter(Boolean).join(' · ');

  // Limpiar canvas anterior
  const container = document.getElementById('qr-modal-canvas');
  if (container) {
    container.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
      const qrText = `AsistApp | ${cls.name}${cls.subject ? ' · ' + cls.subject : ''}${cls.grade ? ' | ' + cls.grade : ''}`;
      new QRCode(container, {
        text: qrText,
        width:  200,
        height: 200,
        colorDark:  '#1a1a2e',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    } else {
      container.innerHTML = '<p style="color:var(--c-text-2);font-size:13px;">QR no disponible (sin conexión)</p>';
    }
  }

  openModal('modal-qr');
}

function openSettings() {
  const inp = document.getElementById('settings-threshold');
  const inpM = document.getElementById('settings-monthly-threshold');
  if (inp)  inp.value  = alertThreshold;
  if (inpM) inpM.value = monthlyThreshold;

  const chkPattern  = document.getElementById('settings-enable-pattern');
  const chkClass    = document.getElementById('settings-enable-classroom');
  const chkRecovery = document.getElementById('settings-enable-recovery');
  if (chkPattern)  chkPattern.checked  = enablePatternAlert;
  if (chkClass)    chkClass.checked    = enableClassroomAlert;
  if (chkRecovery) chkRecovery.checked = enableRecoveryAlert;

  openModal('modal-settings');
}

async function saveSettings() {
  const inp  = document.getElementById('settings-threshold');
  const inpM = document.getElementById('settings-monthly-threshold');
  const val  = parseInt(inp?.value);
  const valM = parseInt(inpM?.value);
  if (isNaN(val)  || val  < 1) { showToast('Ingresa un número válido para el umbral'); return; }
  if (isNaN(valM) || valM < 1) { showToast('Ingresa un número válido para el umbral mensual'); return; }

  alertThreshold    = val;
  monthlyThreshold  = valM;
  enablePatternAlert  = document.getElementById('settings-enable-pattern')?.checked  ?? true;
  enableClassroomAlert = document.getElementById('settings-enable-classroom')?.checked ?? true;
  enableRecoveryAlert = document.getElementById('settings-enable-recovery')?.checked ?? true;

  localStorage.setItem('alertThreshold',      alertThreshold);
  localStorage.setItem('monthlyThreshold',    monthlyThreshold);
  localStorage.setItem('enablePatternAlert',  enablePatternAlert);
  localStorage.setItem('enableClassroomAlert', enableClassroomAlert);
  localStorage.setItem('enableRecoveryAlert', enableRecoveryAlert);

  const ref = settingsRef();
  if (ref) {
    try {
      await ref.set({
        absenceThreshold: val,
        monthlyThreshold: valM,
        enablePattern:    enablePatternAlert,
        enableClassroom:  enableClassroomAlert,
        enableRecovery:   enableRecoveryAlert,
      });
    } catch { /* ignorar si Firebase no está configurado */ }
  }

  closeModal('modal-settings');
  renderMenuThreshold();
  showToast(`Configuración guardada ✓`);
}

function renderMenuThreshold() {
  const el = document.getElementById('menu-threshold-val');
  if (el) el.textContent = `${alertThreshold} ausencias`;
}

// ════════════════════════════════════
// BÚSQUEDA GLOBAL
// ════════════════════════════════════
let globalStudentIndex = []; // { name, classroomId, classroomName, absences }

async function buildGlobalIndex() {
  if (!db || state.classrooms.length === 0) return;
  globalStudentIndex = [];

  await Promise.all(state.classrooms.map(async c => {
    try {
      const [studSnap, sessSnap] = await Promise.all([
        db.collection('classrooms').doc(c.id).collection('students').get(),
        db.collection('classrooms').doc(c.id).collection('sessions')
          .orderBy('date','desc').limit(30).get(),
      ]);

      // Contar ausencias por alumno
      const absentCounts = {};
      sessSnap.docs.forEach(d => {
        getAbsentIds(d.data()).forEach(sid => {
          absentCounts[sid] = (absentCounts[sid] || 0) + 1;
        });
      });

      studSnap.docs.forEach(d => {
        globalStudentIndex.push({
          id:            d.id,
          name:          d.data().name,
          classroomId:   c.id,
          classroomName: c.name,
          absences:      absentCounts[d.id] || 0,
        });
      });
    } catch { /* ignorar */ }
  }));
}

function initSearch() {
  // Búsqueda global de alumnos
  const homeSearch   = document.getElementById('home-search');
  const resultsPanel = document.getElementById('global-search-results');

  if (homeSearch && resultsPanel) {
    homeSearch.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();

      if (!q) {
        resultsPanel.classList.add('hidden');
        return;
      }

      const matches = globalStudentIndex
        .filter(s => s.name.toLowerCase().includes(q) ||
                     s.classroomName.toLowerCase().includes(q))
        .slice(0, 8);

      if (matches.length === 0) {
        resultsPanel.innerHTML = `<div class="sr-empty">Sin resultados para "${esc(q)}"</div>`;
      } else {
        resultsPanel.innerHTML = matches.map(s => {
          const badge = s.absences > 0
            ? `<span class="aa-badge absent">${s.absences} aus.</span>`
            : `<span class="aa-badge present">✓</span>`;
          return `
            <div class="sr-item" onclick="openClassroom('${s.classroomId}');
              document.getElementById('home-search').value='';
              document.getElementById('global-search-results').classList.add('hidden');">
              <div class="sr-avatar">${initials(s.name)}</div>
              <div class="sr-info">
                <div class="sr-name">${esc(s.name)}</div>
                <div class="sr-cls">${esc(s.classroomName)}</div>
              </div>
              ${badge}
            </div>`;
        }).join('');
      }
      resultsPanel.classList.remove('hidden');
    });

    // Cerrar al perder foco
    homeSearch.addEventListener('blur', () => {
      setTimeout(() => resultsPanel.classList.add('hidden'), 200);
    });
  }

  // Filtro en lista de salones
  const classroomsSearch = document.getElementById('classrooms-search');
  if (classroomsSearch) {
    classroomsSearch.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#classrooms-list .classroom-list-item').forEach(item => {
        item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }
}

// ════════════════════════════════════════════════════════
// F7 · AUTENTICACIÓN
// ════════════════════════════════════════════════════════

// ── Helpers UI ───────────────────────────────────────────
function authSetLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Un momento…' : btn.dataset.label || btn.textContent;
}
function authShowError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}
function togglePass(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

// ── Traducir errores de Firebase Auth ────────────────────
function authErrorMsg(code) {
  const map = {
    'auth/user-not-found':       'No existe una cuenta con ese correo.',
    'auth/wrong-password':       'Contraseña incorrecta.',
    'auth/invalid-email':        'Correo electrónico no válido.',
    'auth/email-already-in-use': 'Ese correo ya está registrado.',
    'auth/weak-password':        'La contraseña debe tener al menos 6 caracteres.',
    'auth/too-many-requests':    'Demasiados intentos. Espera un momento.',
    'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
    'auth/invalid-credential':   'Correo o contraseña incorrectos.',
  };
  return map[code] || 'Error al autenticar. Intenta de nuevo.';
}

// ── Iniciar sesión ────────────────────────────────────────
async function signIn() {
  const email = document.getElementById('login-email')?.value.trim();
  const pass  = document.getElementById('login-password')?.value;
  authShowError('login-error', '');
  if (!email || !pass) { authShowError('login-error', 'Completa todos los campos.'); return; }

  authSetLoading('login-btn', true);
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthChanged se dispara automáticamente
  } catch (e) {
    authShowError('login-error', authErrorMsg(e.code));
    authSetLoading('login-btn', false);
  }
}

// ── Registrar cuenta ──────────────────────────────────────
async function signUp() {
  const name  = document.getElementById('reg-name')?.value.trim();
  const email = document.getElementById('reg-email')?.value.trim();
  const pass  = document.getElementById('reg-password')?.value;
  authShowError('reg-error', '');

  if (!name)  { authShowError('reg-error', 'Escribe tu nombre.'); return; }
  if (!email) { authShowError('reg-error', 'Escribe tu correo.'); return; }
  if (!pass)  { authShowError('reg-error', 'Escribe una contraseña.'); return; }

  authSetLoading('reg-btn', true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    // Guardar nombre en Firebase Auth + colección users
    await cred.user.updateProfile({ displayName: name });
    if (db) {
      await db.collection('users').doc(cred.user.uid).set({
        name, email, role: 'teacher', createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    // onAuthChanged se dispara automáticamente
  } catch (e) {
    authShowError('reg-error', authErrorMsg(e.code));
    authSetLoading('reg-btn', false);
  }
}

// ── Recuperar contraseña ──────────────────────────────────
async function sendPasswordReset() {
  const email = document.getElementById('forgot-email')?.value.trim();
  authShowError('forgot-error', '');
  const successEl = document.getElementById('forgot-success');
  if (successEl) successEl.classList.add('hidden');
  if (!email) { authShowError('forgot-error', 'Escribe tu correo.'); return; }

  try {
    await auth.sendPasswordResetEmail(email);
    if (successEl) {
      successEl.textContent = `Correo enviado a ${email}. Revisa tu bandeja.`;
      successEl.classList.remove('hidden');
    }
  } catch (e) {
    authShowError('forgot-error', authErrorMsg(e.code));
  }
}

// ── Cerrar sesión ─────────────────────────────────────────
function confirmSignOut() {
  if (confirm('¿Cerrar sesión?')) signOut();
}
async function signOut() {
  try {
    await auth.signOut();
    // onAuthChanged se encarga de redirigir al login
  } catch (e) {
    showToast('Error al cerrar sesión');
  }
}

// ── Perfil del docente ────────────────────────────────────
function renderMenuProfile(user) {
  const nameEl   = document.getElementById('menu-user-name');
  const emailEl  = document.getElementById('menu-user-email');
  const avatarEl = document.getElementById('menu-avatar-initials');
  const name = user.displayName || 'Docente';
  if (nameEl)   nameEl.textContent  = name;
  if (emailEl)  emailEl.textContent = user.email || '—';
  if (avatarEl) avatarEl.textContent = initials(name);

  // También actualizar avatar del home si existe
  const homeAvEl = document.getElementById('home-avatar');
  if (homeAvEl) homeAvEl.textContent = initials(name);
}

function loadProfileView() {
  const user = currentUser || auth?.currentUser;
  if (!user) return;
  const name = user.displayName || '';
  const nameInp  = document.getElementById('profile-name-input');
  const emailInp = document.getElementById('profile-email-input');
  const avatarLg = document.getElementById('profile-avatar-lg-doc');
  const nameDisp = document.getElementById('profile-name-display');
  const emailDisp = document.getElementById('profile-email-display');
  if (nameInp)   nameInp.value    = name;
  if (emailInp)  emailInp.value   = user.email || '';
  if (avatarLg)  avatarLg.textContent = initials(name || user.email || 'P');
  if (nameDisp)  nameDisp.textContent = name || 'Sin nombre';
  if (emailDisp) emailDisp.textContent = user.email || '—';
}

async function saveProfile() {
  const user = auth?.currentUser;
  if (!user) return;
  const name  = document.getElementById('profile-name-input')?.value.trim();
  const email = document.getElementById('profile-email-input')?.value.trim();
  if (!name) { showToast('Escribe tu nombre'); return; }

  try {
    await user.updateProfile({ displayName: name });
    if (email && email !== user.email) {
      await user.updateEmail(email);
    }
    if (db) {
      await db.collection('users').doc(user.uid).set(
        { name, email: user.email }, { merge: true }
      );
    }
    renderMenuProfile(user);
    loadProfileView();
    showToast('Perfil actualizado ✓');
  } catch (e) {
    showToast('Error: ' + (e.message || 'Intenta de nuevo'));
  }
}

async function changePassword() {
  const user = auth?.currentUser;
  if (!user) return;
  const newPass = document.getElementById('profile-new-pass')?.value;
  if (!newPass || newPass.length < 6) { showToast('Mínimo 6 caracteres'); return; }
  try {
    await user.updatePassword(newPass);
    document.getElementById('profile-new-pass').value = '';
    showToast('Contraseña cambiada ✓');
  } catch (e) {
    if (e.code === 'auth/requires-recent-login') {
      showToast('Por seguridad, cierra sesión y vuelve a entrar antes de cambiar la contraseña.');
    } else {
      showToast('Error al cambiar contraseña');
    }
  }
}

// ════════════════════════════════════
// FORZAR ACTUALIZACIÓN DEL SW
// ════════════════════════════════════
async function forceAppUpdate() {
  if (!('serviceWorker' in navigator)) {
    showToast('Service Worker no disponible');
    return;
  }
  showToast('Buscando actualización…');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { window.location.reload(); return; }

    await reg.update(); // re-descarga service-worker.js del servidor

    window._awaitingAppUpdateReload = true; // acción explícita del usuario: sí se permite recargar

    const newSW = reg.waiting || reg.installing;
    if (newSW) {
      // Hay versión nueva: activarla. El listener 'controllerchange'
      // (index.html) recarga solo cuando el SW nuevo toma control.
      showToast('Instalando nueva versión…');
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        newSW.addEventListener('statechange', e => {
          if (e.target.state === 'installed') e.target.postMessage({ type: 'SKIP_WAITING' });
        });
      }
      // Respaldo por si controllerchange no dispara (p.ej. iOS antiguo)
      setTimeout(() => window.location.reload(), 4000);
    } else {
      // Sin SW nuevo: recargar igual — los archivos propios son Network First,
      // así que la recarga trae la última versión de app.js/styles.css.
      showToast('Ya tienes la última versión ✓');
      setTimeout(() => window.location.reload(), 700);
    }
  } catch (e) {
    showToast('Error al actualizar: ' + e.message);
  }
}

// Se llama al tocar el banner "Nueva versión disponible". El SW nuevo ya
// quedó activado (SKIP_WAITING) cuando se detectó; aquí solo se autoriza
// y dispara el reload — siempre por una acción explícita del usuario,
// nunca a la fuerza a mitad de un guardado o de generar un PDF.
function applyAppUpdate() {
  window._awaitingAppUpdateReload = true;
  document.getElementById('update-banner')?.classList.add('hidden');
  showToast('Actualizando…');
  setTimeout(() => window.location.reload(), 300);
}

// ════════════════════════════════════
// OFFLINE / ONLINE
// ════════════════════════════════════
function initOfflineDetection() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;

  function update() {
    if (navigator.onLine) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      showToast('📡 Sin conexión · Usando datos en caché');
    }
  }

  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update(); // estado inicial
}

// ════════════════════════════════════════════════════════
// MODO SWIPE — izquierda ausente / derecha presente
// ════════════════════════════════════════════════════════

const swipe = {
  students:  [],       // lista completa de alumnos del salón
  decisions: {},       // { studentId: 'present' | 'absent' }
  history:   [],       // historial de IDs para undo
  index:     0,        // índice del alumno actual
};

// ── Abrir modo swipe ─────────────────────────────────────
function openSwipeAttendance() {
  const cls = state.currentClassroom;
  if (!cls) return;
  if (state.students.length === 0) {
    showToast('Agrega alumnos antes de tomar asistencia');
    return;
  }

  // Resetear estado
  editingSession  = null; // swipe siempre crea sesión nueva
  swipe.students  = [...state.students];
  swipe.decisions = {};
  swipe.history   = [];
  swipe.index     = 0;

  // Rellenar header
  const clsEl = document.getElementById('sw-header-cls');
  if (clsEl) clsEl.textContent = cls.name;

  // Mostrar fase de tarjetas
  document.getElementById('sw-phase-cards')?.classList.remove('hidden');
  document.getElementById('sw-phase-summary')?.classList.add('hidden');

  // Fecha de hoy por defecto en los campos de metadata
  const swDate = document.getElementById('sw-date');
  if (swDate) swDate.value = todayISO();
  // Limpiar tema y observaciones de la clase anterior (cada clase es nueva)
  const swTopic = document.getElementById('sw-topic');
  if (swTopic) swTopic.value = '';
  const swNotes = document.getElementById('sw-notes');
  if (swNotes) swNotes.value = '';

  navigateTo('swipe-attendance');
  swipeRenderCard();
}

// ── Renderizar tarjeta activa y la de fondo ──────────────
function swipeRenderCard() {
  const total = swipe.students.length;
  const i     = swipe.index;

  // Progreso
  const pct = total > 0 ? Math.round(i / total * 100) : 0;
  const fillEl  = document.getElementById('sw-progress-fill');
  const labelEl = document.getElementById('sw-progress-label');
  if (fillEl)  fillEl.style.width = pct + '%';
  if (labelEl) labelEl.textContent = `${i + 1} / ${total}`;

  // Si ya no hay más, mostrar resumen
  if (i >= total) { swipeShowSummary(); return; }

  const st = swipe.students[i];
  const bg = AVATAR_COLORS[i % AVATAR_COLORS.length];

  // Tarjeta activa
  const card    = document.getElementById('sw-card-active');
  const avatarEl = document.getElementById('sw-card-avatar');
  const nameEl   = document.getElementById('sw-card-name');
  const numEl    = document.getElementById('sw-card-num');
  if (avatarEl) { avatarEl.textContent = initials(st.name); avatarEl.style.background = bg; }
  if (nameEl)   nameEl.textContent = st.name;
  if (numEl)    numEl.textContent  = `#${i + 1}`;

  // Reset overlays
  swipeSetOverlay(0);

  // Quitar clases de animación sobrantes
  if (card) {
    card.classList.remove('fly-left', 'fly-right', 'is-dragging');
    card.style.transform = '';
  }

  // Tarjeta de fondo (siguiente alumno)
  const next = swipe.students[i + 1];
  const bgCard   = document.getElementById('sw-card-bg');
  const bgAvatar = document.getElementById('sw-card-bg-avatar');
  const bgName   = document.getElementById('sw-card-bg-name');
  if (next) {
    const bgColor = AVATAR_COLORS[(i + 1) % AVATAR_COLORS.length];
    if (bgAvatar) { bgAvatar.textContent = initials(next.name); bgAvatar.style.background = bgColor; }
    if (bgName)   bgName.textContent = next.name;
    if (bgCard)   bgCard.style.display = '';
  } else {
    if (bgCard) bgCard.style.display = 'none';
  }

  // Inicializar eventos touch/mouse para esta tarjeta
  swipeBindDrag(card);
}

// ── Controlar opacidad de overlays ──────────────────────
function swipeSetOverlay(dx) {
  const leftEl  = document.getElementById('sw-overlay-left');
  const rightEl = document.getElementById('sw-overlay-right');
  const threshold = 60;
  if (dx < 0) {
    const o = Math.min(1, Math.abs(dx) / threshold);
    if (leftEl)  leftEl.style.opacity  = o;
    if (rightEl) rightEl.style.opacity = 0;
  } else if (dx > 0) {
    const o = Math.min(1, dx / threshold);
    if (rightEl) rightEl.style.opacity = o;
    if (leftEl)  leftEl.style.opacity  = 0;
  } else {
    if (leftEl)  leftEl.style.opacity  = 0;
    if (rightEl) rightEl.style.opacity = 0;
  }
}

// ── Drag / touch handlers ────────────────────────────────
function swipeBindDrag(card) {
  if (!card) return;

  // Clonar para eliminar listeners anteriores
  const fresh = card.cloneNode(true);
  card.replaceWith(fresh);
  const c = document.getElementById('sw-card-active');
  if (!c) return;

  // Re-referenciar overlays (están dentro del clon)
  let startX = 0, startY = 0, curX = 0, isDragging = false;
  const THRESHOLD = 100; // px para confirmar swipe

  function onStart(x, y) {
    startX = x; startY = y; curX = 0; isDragging = true;
    c.classList.add('is-dragging');
    c.style.transition = 'none';
  }
  function onMove(x) {
    if (!isDragging) return;
    curX = x - startX;
    const rot = curX * 0.08;
    c.style.transform = `translateX(${curX}px) rotate(${rot}deg)`;
    swipeSetOverlay(curX);
    // Peek de la tarjeta de fondo
    const bgCard = document.getElementById('sw-card-bg');
    if (bgCard) bgCard.classList.toggle('peek', Math.abs(curX) > 40);
  }
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    c.classList.remove('is-dragging');
    if (Math.abs(curX) >= THRESHOLD) {
      swipeDecide(curX < 0 ? 'absent' : 'present');
    } else {
      // Snap back
      c.style.transition = 'transform .3s cubic-bezier(.25,.46,.45,.94)';
      c.style.transform  = '';
      swipeSetOverlay(0);
      const bgCard = document.getElementById('sw-card-bg');
      if (bgCard) bgCard.classList.remove('peek');
    }
  }

  // Touch
  c.addEventListener('touchstart', e => {
    const t = e.touches[0];
    onStart(t.clientX, t.clientY);
  }, { passive: true });
  c.addEventListener('touchmove', e => {
    const t = e.touches[0];
    onMove(t.clientX);
  }, { passive: true });
  c.addEventListener('touchend', onEnd);

  // Mouse (pruebas en desktop)
  // Los listeners de window se registran UNA sola vez y delegan en los
  // handlers de la tarjeta activa (antes se acumulaban en cada tarjeta).
  c.addEventListener('mousedown', e => { onStart(e.clientX, e.clientY); });
  _swipeDrag = { onMove: x => { if (isDragging) onMove(x); }, onEnd: () => { if (isDragging) onEnd(); } };
}

let _swipeDrag = null;
window.addEventListener('mousemove', e => _swipeDrag?.onMove(e.clientX));
window.addEventListener('mouseup',   () => _swipeDrag?.onEnd());

// ── Decidir: 'present' | 'absent' ───────────────────────
function swipeDecide(direction) {
  const i  = swipe.index;
  if (i >= swipe.students.length) return;
  const st = swipe.students[i];

  swipe.decisions[st.id] = direction;
  swipe.history.push(st.id);

  // Animar salida
  const card = document.getElementById('sw-card-active');
  if (card && (direction === 'absent' || direction === 'present')) {
    // Asegurar que el overlay final sea visible brevemente
    swipeSetOverlay(direction === 'absent' ? -120 : 120);
    card.classList.add(direction === 'absent' ? 'fly-left' : 'fly-right');
    card.addEventListener('animationend', () => {
      swipe.index++;
      swipeRenderCard();
    }, { once: true });
  } else {
    // 'late' (u otros) → avanzar directo, sin deslizar
    if (direction === 'late') showToast('🕐 Marcado tarde');
    swipe.index++;
    swipeRenderCard();
  }
}

// ── Deshacer último swipe ────────────────────────────────
function swipeUndo() {
  if (swipe.history.length === 0) { showToast('Sin acciones para deshacer'); return; }
  const lastId = swipe.history.pop();
  delete swipe.decisions[lastId];
  swipe.index = Math.max(0, swipe.index - 1);
  swipeRenderCard();
  showToast('Acción deshecha ↩');
}

// ── Mostrar pantalla de resumen ──────────────────────────
function swipeShowSummary() {
  document.getElementById('sw-phase-cards')?.classList.add('hidden');
  document.getElementById('sw-phase-summary')?.classList.remove('hidden');

  const total   = swipe.students.length;
  const absentIds = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'absent').map(([id]) => id);
  const lateIds = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'late').map(([id]) => id);
  const presentCount = total - absentIds.length - lateIds.length;

  // Stats — los que llegaron tarde cuentan como presentes pero se muestran aparte
  const statsEl = document.getElementById('sw-summary-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="sw-stat-pill present">
        <div class="sw-stat-num">${presentCount}</div>
        <div class="sw-stat-lab">Presentes</div>
      </div>
      ${lateIds.length ? `
      <div class="sw-stat-pill late">
        <div class="sw-stat-num">${lateIds.length}</div>
        <div class="sw-stat-lab">Tarde</div>
      </div>` : ''}
      <div class="sw-stat-pill absent">
        <div class="sw-stat-num">${absentIds.length}</div>
        <div class="sw-stat-lab">Ausentes</div>
      </div>`;
  }

  // Lista de ausentes (chips tocables para remover)
  const absentListEl = document.getElementById('sw-absent-list');
  const absentWrap   = document.getElementById('sw-absent-list-wrap');
  if (absentListEl) {
    if (absentIds.length === 0) {
      if (absentWrap) absentWrap.style.display = 'none';
    } else {
      if (absentWrap) absentWrap.style.display = '';
      // Mapa id → número de lista (orden alfabético, igual que el diario)
      const numById = {};
      [...state.students]
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }))
        .forEach((st, idx) => { numById[st.id] = idx + 1; });
      absentListEl.innerHTML = absentIds.map(sid => {
        const st = swipe.students.find(s => s.id === sid);
        if (!st) return '';
        const n = numById[sid];
        const numTag = n ? `<b>${n}.</b> ` : '';
        return `<span class="sw-absent-chip" onclick="swipeToggleAbsent('${sid}')" title="Toca para marcar como presente">
          ✕ ${numTag}${esc(st.name)}
        </span>`;
      }).join('');
    }
  }
}

// ── Quitar un ausente desde la pantalla de resumen ───────
function swipeToggleAbsent(studentId) {
  swipe.decisions[studentId] = 'present';
  swipeShowSummary(); // re-renderizar
}

// ── Guardar desde el resumen (conecta con Firebase) ──────
async function saveSwipeAttendance() {
  const cls = state.currentClassroom;
  if (!cls) { showToast('Sin salón seleccionado'); return; }

  const dateVal = document.getElementById('sw-date')?.value;
  const topic   = document.getElementById('sw-topic')?.value.trim();
  const notes   = document.getElementById('sw-notes')?.value.trim();

  if (!dateVal) { markFieldInvalid('sw-date', '⚠️ Selecciona la fecha'); return; }
  if (!topic)   { markFieldInvalid('sw-topic', '⚠️ Falta el tema de la clase'); return; }

  // Aviso si ya existe una clase ese día en este salón (evita duplicados)
  if (checkDuplicateSession(dateVal, () => saveSwipeAttendance())) return;

  // Construir listas a partir de las decisiones
  const absentStudents = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'absent').map(([id]) => id);
  const lateStudents = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'late').map(([id]) => id);

  const sessionData = {
    date:           firebase.firestore.Timestamp.fromDate(new Date(dateVal + 'T12:00:00')),
    topic,
    notes,
    absentStudents,
    lateStudents,
    totalStudents:  swipe.students.length,
    createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    // Sin await: offline Firestore no resuelve hasta reconectar (ver saveAttendance).
    const ref = db.collection('classrooms').doc(cls.id)
      .collection('sessions').doc();
    ref.set(sessionData).catch(err => {
      console.error('[Sync] Error al sincronizar asistencia:', err);
    });

    showToast(navigator.onLine ? 'Asistencia guardada ✓' : 'Guardada offline — se sincronizará al reconectar ✓');
    _skipAttendanceGuard = true;
    navigateTo('classroom-detail', cls);
    _skipAttendanceGuard = false;
    await loadSessions(cls.id);
    switchSegment('history');
    // Mostrar números de lista de ausentes para el diario
    showInasistenciasModal(absentStudents);

    // F6: Evaluar alertas en background
    evaluateAlerts(cls.id).then(alerts => {
      _alertsCache = _alertsCache.filter(a => a.classroomId !== cls.id);
      _alertsCache.push(...alerts);
      updateAlertBadge();
    }).catch(() => {});

  } catch (e) {
    console.error(e);
    showToast('Error al guardar asistencia');
  }
}

// ── Cambiar al modo lista (vista tradicional) ────────────
function switchToListMode() {
  // Guardar antes de navegar (navigateTo resetea el estado de la vista)
  const absentCopy = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'absent').map(([id]) => id);
  const lateCopy = Object.entries(swipe.decisions)
    .filter(([, d]) => d === 'late').map(([id]) => id);
  const swDate  = document.getElementById('sw-date')?.value;
  const swTopic = document.getElementById('sw-topic')?.value;
  const swNotes = document.getElementById('sw-notes')?.value;

  // Cambio de modo legítimo: los datos se conservan, no pedir confirmación
  _skipAttendanceGuard = true;
  navigateTo('take-attendance');
  _skipAttendanceGuard = false;

  // Restaurar decisiones y metadata DESPUÉS del reset de navigateTo
  state.absentIds = new Set(absentCopy);
  state.lateIds   = new Set(lateCopy);
  if (swDate)  { const el = document.getElementById('attendance-date');  if (el) el.value = swDate; }
  if (swTopic) { const el = document.getElementById('attendance-topic'); if (el) el.value = swTopic; }
  if (swNotes) { const el = document.getElementById('attendance-notes'); if (el) el.value = swNotes; }
  renderAttendanceStudents();
  applyAttendanceMarks();
  updateAbsentCount();
}

// ── Salir del modo swipe sin guardar ─────────────────────
function exitSwipeMode() {
  navigateTo('classroom-detail', state.currentClassroom);
}

// ════════════════════════════════════════════════════════
// F6 · ALERTAS INTELIGENTES
// ════════════════════════════════════════════════════════

// Estado de configuración de alertas (cargado desde loadSettings)
let monthlyThreshold    = 4;
let enablePatternAlert  = true;
let enableRecoveryAlert = true;
let enableClassroomAlert = true;

// Cache local de alertas evaluadas (array de objetos alerta)
let _alertsCache = [];

/* ── evaluateAlerts ─────────────────────────────────────────
   Evalúa los 4 tipos de alerta para un salón y persiste
   el resultado en Firestore alerts/{classroomId}.
   También devuelve el array para uso inmediato.
──────────────────────────────────────────────────────────── */
async function evaluateAlerts(classroomId) {
  if (!db || !classroomId) return [];

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear  = now.getFullYear();

  try {
    const [studSnap, sessSnap] = await Promise.all([
      db.collection('classrooms').doc(classroomId).collection('students').get(),
      db.collection('classrooms').doc(classroomId).collection('sessions')
        .orderBy('date', 'desc').limit(50).get(),
    ]);

    const students = studSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const cls = state.classrooms.find(c => c.id === classroomId) || { name: classroomId };
    const alerts = [];

    // ── 1. Alerta de umbral mensual ───────────────────────────
    // Cuenta ausencias del mes actual por alumno
    const monthlyAbsences = {};
    sessions.forEach(s => {
      const d = tsToDate(s.date);
      if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
        getAbsentIds(s).forEach(sid => {
          monthlyAbsences[sid] = (monthlyAbsences[sid] || 0) + 1;
        });
      }
    });
    students.forEach(st => {
      const count = monthlyAbsences[st.id] || 0;
      if (count >= monthlyThreshold) {
        alerts.push({
          id:            `threshold_${classroomId}_${st.id}`,
          type:          'threshold',
          classroomId,
          classroomName: cls.name,
          studentId:     st.id,
          studentName:   st.name,
          count,
          message:       `${st.name} tiene ${count} ausencia${count !== 1 ? 's' : ''} este mes (límite: ${monthlyThreshold})`,
          severity:      count >= monthlyThreshold * 1.5 ? 'high' : 'medium',
          createdAt:     Date.now(),
          dismissed:     false,
        });
      }
    });

    // ── 2. Alerta de patrón (3 sesiones consecutivas ausente) ─
    if (enablePatternAlert) {
      students.forEach(st => {
        // Tomar las últimas 10 sesiones y revisar si las últimas 3 tiene al alumno ausente
        const recent = sessions.slice(0, 10);
        if (recent.length < 3) return;
        const lastThree = recent.slice(0, 3);
        const absentIn3 = lastThree.every(s => getAbsentIds(s).includes(st.id));
        if (absentIn3) {
          alerts.push({
            id:            `pattern_${classroomId}_${st.id}`,
            type:          'pattern',
            classroomId,
            classroomName: cls.name,
            studentId:     st.id,
            studentName:   st.name,
            count:         3,
            message:       `${st.name} ha faltado en las últimas 3 clases consecutivas`,
            severity:      'high',
            createdAt:     Date.now(),
            dismissed:     false,
          });
        }
      });
    }

    // ── 3. Alerta de salón inactivo (sin sesión en 7 días) ────
    if (enableClassroomAlert) {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      if (sessions.length === 0) {
        alerts.push({
          id:            `classroom_${classroomId}`,
          type:          'classroom',
          classroomId,
          classroomName: cls.name,
          message:       `${cls.name} no tiene ninguna clase registrada aún`,
          severity:      'medium',
          createdAt:     Date.now(),
          dismissed:     false,
        });
      } else {
        const lastDate = tsToDate(sessions[0].date);
        if (lastDate < sevenDaysAgo) {
          const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
          alerts.push({
            id:            `classroom_${classroomId}`,
            type:          'classroom',
            classroomId,
            classroomName: cls.name,
            daysAgo,
            message:       `${cls.name} no registra clases hace ${daysAgo} días`,
            severity:      'medium',
            createdAt:     Date.now(),
            dismissed:     false,
          });
        }
      }
    }

    // ── 4. Alerta de recuperación (5+ sesiones sin falta) ─────
    if (enableRecoveryAlert) {
      const recoveryStreak = 5;
      const recent5 = sessions.slice(0, recoveryStreak);
      if (recent5.length >= recoveryStreak) {
        students.forEach(st => {
          const neverAbsent = recent5.every(s => !getAbsentIds(s).includes(st.id));
          // Solo alertar si antes había ausencias (para que sea una recuperación real)
          const hadAbsences = sessions.slice(recoveryStreak).some(
            s => getAbsentIds(s).includes(st.id)
          );
          if (neverAbsent && hadAbsences) {
            alerts.push({
              id:            `recovery_${classroomId}_${st.id}`,
              type:          'recovery',
              classroomId,
              classroomName: cls.name,
              studentId:     st.id,
              studentName:   st.name,
              count:         recoveryStreak,
              message:       `🌟 ${st.name} lleva ${recoveryStreak} clases seguidas asistiendo sin faltar`,
              severity:      'low',
              createdAt:     Date.now(),
              dismissed:     false,
            });
          }
        });
      }
    }

    // Persistir en Firebase (un doc por salón)
    if (db) {
      try {
        await db.collection('alerts').doc(classroomId).set({
          classroomId,
          ownerId:   auth?.currentUser?.uid || null,
          alerts,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } catch { /* ignorar si sin conexión */ }
    }

    return alerts;
  } catch (e) {
    console.warn('[Alertas] Error evaluando', classroomId, e);
    return [];
  }
}

/* ── loadAllAlerts ──────────────────────────────────────────
   Carga alertas de todos los salones desde Firebase
   y las guarda en _alertsCache.
──────────────────────────────────────────────────────────── */
async function loadAllAlerts() {
  if (!db) return [];
  try {
    // Solo las alertas del docente actual (antes se descargaban TODAS)
    const uid = auth?.currentUser?.uid;
    let query = db.collection('alerts');
    if (uid) query = query.where('ownerId', '==', uid);
    const snap = await query.get();
    _alertsCache = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data.alerts) _alertsCache.push(...data.alerts);
    });
    // Leer dismissed desde localStorage
    const dismissed = JSON.parse(localStorage.getItem('dismissedAlerts') || '[]');
    _alertsCache.forEach(a => {
      if (dismissed.includes(a.id)) a.dismissed = true;
    });
    updateAlertBadge();
    return _alertsCache;
  } catch {
    return _alertsCache;
  }
}

/* ── updateAlertBadge ───────────────────────────────────────
   Actualiza el badge numérico en el ícono del nav.
──────────────────────────────────────────────────────────── */
function updateAlertBadge() {
  const badge = document.getElementById('alert-nav-badge');
  if (!badge) return;
  const active = _alertsCache.filter(a => !a.dismissed && a.type !== 'recovery').length;
  if (active > 0) {
    badge.textContent = active > 9 ? '9+' : String(active);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* ── loadAlertsView ─────────────────────────────────────────
   Carga y renderiza la vista completa de alertas.
──────────────────────────────────────────────────────────── */
let _alertFilter = 'all';

async function loadAlertsView() {
  const listEl    = document.getElementById('al-list');
  const emptyEl   = document.getElementById('al-empty');
  const countEl   = document.getElementById('al-count-label');
  if (!listEl) return;

  listEl.innerHTML = '<div style="color:var(--c-text-2);font-size:13px;padding:12px 0;">Cargando alertas…</div>';

  const alerts = await loadAllAlerts();
  renderAlertsView(alerts);
}

function renderAlertsView(alerts) {
  const listEl  = document.getElementById('al-list');
  const emptyEl = document.getElementById('al-empty');
  const countEl = document.getElementById('al-count-label');
  if (!listEl) return;

  // Aplicar filtro
  const filtered = _alertFilter === 'all'
    ? alerts
    : alerts.filter(a => a.type === _alertFilter);

  const active = filtered.filter(a => !a.dismissed);
  const dismissed = filtered.filter(a => a.dismissed);
  const sorted = [...active, ...dismissed];

  // Conteo
  if (countEl) {
    const total = active.length;
    countEl.textContent = total === 0
      ? 'Sin alertas activas'
      : `${total} alerta${total !== 1 ? 's' : ''} activa${total !== 1 ? 's' : ''}`;
  }

  if (sorted.length === 0) {
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  const typeIcon = { threshold: '⚠️', pattern: '🔁', classroom: '🏫', recovery: '🌟' };
  const typeLabel = { threshold: 'Umbral', pattern: 'Patrón', classroom: 'Salón inactivo', recovery: 'Recuperación' };

  listEl.innerHTML = sorted.map(a => `
    <div class="al-card type-${a.type} ${a.dismissed ? 'dismissed' : ''}" id="al-card-${esc(a.id)}">
      <div class="al-card-icon">${typeIcon[a.type] || '🔔'}</div>
      <div class="al-card-body">
        <div class="al-card-title">${typeLabel[a.type] || a.type}</div>
        <div class="al-card-msg">${esc(a.message)}</div>
        <div class="al-card-cls">👥 ${esc(a.classroomName)}</div>
      </div>
      <button class="al-card-dismiss" onclick="dismissAlert('${esc(a.id)}')"
              title="${a.dismissed ? 'Restaurar' : 'Descartar'}">
        ${a.dismissed ? '↩' : '✕'}
      </button>
    </div>
  `).join('');
}

function filterAlerts(type) {
  _alertFilter = type;
  // Actualizar botones
  ['all','threshold','pattern','classroom','recovery'].forEach(t => {
    const btn = document.getElementById(`al-f-${t}`);
    if (btn) btn.classList.toggle('active', t === type);
  });
  renderAlertsView(_alertsCache);
}

function dismissAlert(alertId) {
  const alert = _alertsCache.find(a => a.id === alertId);
  if (!alert) return;
  alert.dismissed = !alert.dismissed;

  // Persistir lista de dismissed en localStorage
  const dismissed = _alertsCache.filter(a => a.dismissed).map(a => a.id);
  localStorage.setItem('dismissedAlerts', JSON.stringify(dismissed));

  updateAlertBadge();
  renderAlertsView(_alertsCache);
}

function clearDismissedAlerts() {
  _alertsCache = _alertsCache.filter(a => !a.dismissed);
  localStorage.setItem('dismissedAlerts', '[]');
  updateAlertBadge();
  renderAlertsView(_alertsCache);
  showToast('Alertas descartadas eliminadas ✓');
}

// ════════════════════════════════════
// ARRANQUE
// ════════════════════════════════════
document.addEventListener('DOMContentLoaded', initApp);
