/* ============================================================
   reports.js — Módulo de Reportes para AsistApp v1.0
   ============================================================
   Depende de: app.js (globals: db, state, alertThreshold,
   getAbsentIds, getJustification, tsToDate, isoFromTimestamp,
   formatDateLong, todayISO, showToast, navigateTo, AVATAR_COLORS)
   Librerías: jsPDF 2.5.1, jsPDF-autotable 3.5.31, SheetJS 0.18.5,
              qrcode.js 1.0.0
   ============================================================ */

'use strict';

// ── Colores PDF ───────────────────────────────────────────────
const R_PRIMARY = [67,  97, 238];
const R_GREEN   = [5,  150, 105];
const R_RED     = [220, 38,  38];
const R_YELLOW  = [217, 119,  6];
const R_DARK    = [26,  26,  46];
const R_GRAY    = [138, 138, 154];
const R_LIGHT   = [244, 245, 247];
const R_WHITE   = [255, 255, 255];
const R_ORANGE  = [234, 88,  12];

// ── Helpers ───────────────────────────────────────────────────
function rPct(present, total) {
  return total > 0 ? Math.round(present / total * 100) : 100;
}
function rColorPct(pct) {
  return pct >= 90 ? R_GREEN : pct >= 75 ? R_YELLOW : R_RED;
}
function rFileDate() {
  return toLocalISO(new Date());
}
function rSafeFilename(str) {
  return (str || 'AsistApp').replace(/[^a-z0-9]/gi, '_');
}
// Marca de asistencia de un alumno en una sesión: A (ausente), T (tarde) o P (presente)
function rMark(session, studentId) {
  if (getAbsentIds(session).includes(studentId)) return 'A';
  if ((session.lateStudents || []).includes(studentId)) return 'T';
  return 'P';
}

// ── Generador de QR como Data URL ────────────────────────────
// Crea un QR en un canvas temporal y devuelve una Promise<string> con el dataURL PNG
function generateQRDataURL(text, size = 120) {
  return new Promise((resolve, reject) => {
    if (typeof QRCode === 'undefined') { resolve(null); return; }
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:' + size + 'px;height:' + size + 'px;';
    document.body.appendChild(container);
    try {
      new QRCode(container, {
        text,
        width:  size,
        height: size,
        colorDark:  '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
      // QRCode genera la imagen de forma síncrona en el canvas
      setTimeout(() => {
        const canvas = container.querySelector('canvas');
        const img    = container.querySelector('img');
        let dataURL  = null;
        if (canvas) {
          dataURL = canvas.toDataURL('image/png');
        } else if (img) {
          dataURL = img.src;
        }
        document.body.removeChild(container);
        resolve(dataURL);
      }, 80);
    } catch (e) {
      try { document.body.removeChild(container); } catch (_) {}
      resolve(null);
    }
  });
}

// Insertar QR en un documento jsPDF (esquina superior derecha del header)
async function rAddQRtoPDF(doc, text, x, y, size = 22) {
  try {
    const dataURL = await generateQRDataURL(text, 200);
    if (dataURL) {
      doc.addImage(dataURL, 'PNG', x, y, size, size);
    }
  } catch (_) { /* silencioso si QR no está disponible */ }
}

// Obtener datos de un salón desde Firestore
async function rFetchData(classroomId, allSessions = false) {
  if (!db) throw new Error('Firebase no configurado — edita firebase-config.js con tus credenciales');
  if (!classroomId) throw new Error('No hay salón seleccionado');

  // Reusar los datos ya cargados del salón abierto (ahorra 50-200 lecturas
  // por reporte). state.students viene ordenado por nombre y state.sessions
  // desc por fecha — aquí se necesita asc, así que se reordena una copia.
  if (state.currentClassroom?.id === classroomId
      && state.students.length && state.sessions.length) {
    return {
      students: [...state.students],
      sessions: [...state.sessions].sort((a, b) => tsToDate(a.date) - tsToDate(b.date)),
    };
  }

  let sessQ = db.collection('classrooms').doc(classroomId).collection('sessions').orderBy('date', 'asc');
  const [studSnap, sessSnap] = await Promise.all([
    db.collection('classrooms').doc(classroomId).collection('students').orderBy('name').get(),
    sessQ.get(),
  ]);
  const students = studSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { students, sessions };
}

// Encabezado PDF común
function rHeader(doc, subtitle, rightText) {
  doc.setFillColor(...R_PRIMARY);
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), 30, 'F');
  doc.setTextColor(...R_WHITE);
  doc.setFontSize(20); doc.setFont('helvetica', 'bold');
  doc.text('AsistApp', 14, 12);
  doc.setFontSize(9);  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, 14, 21);
  if (rightText) {
    doc.setFontSize(8);
    doc.text(rightText, doc.internal.pageSize.getWidth() - 14, 21, { align: 'right' });
  }
}

// Pie de página PDF común (con firma)
function rFooter(doc) {
  const W = doc.internal.pageSize.getWidth();
  const pages = doc.internal.getNumberOfPages();
  const now = new Date().toLocaleDateString('es-ES');
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const y = doc.internal.pageSize.getHeight() - 8;
    doc.setDrawColor(...R_GRAY); doc.setLineWidth(0.3);
    doc.line(14, y - 4, W - 14, y - 4);
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...R_GRAY);
    doc.text(`AsistApp · Generado el ${now} · Pág ${p}/${pages}`, W / 2, y, { align: 'center' });
  }
  // Espacio para firma en última página
  doc.setPage(pages);
  const baseY = doc.internal.pageSize.getHeight() - 26;
  if (baseY > 180) {
    doc.setDrawColor(...R_GRAY); doc.setLineWidth(0.3);
    doc.line(14, baseY, 80, baseY);
    doc.setFontSize(7.5); doc.setTextColor(...R_GRAY);
    doc.text('Firma del docente', 47, baseY + 4, { align: 'center' });
    doc.line(W - 80, baseY, W - 14, baseY);
    doc.text('Sello', W - 47, baseY + 4, { align: 'center' });
  }
}

// Bloque de salón en PDF
function rClassroomBlock(doc, cls, y) {
  doc.setTextColor(...R_DARK);
  doc.setFontSize(17); doc.setFont('helvetica', 'bold');
  doc.text(cls.name, 14, y);
  const sub = [cls.subject, cls.grade].filter(Boolean).join(' · ');
  if (sub) {
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(...R_GRAY);
    doc.text(sub, 14, y + 7);
    return y + 13;
  }
  return y + 8;
}

// Celdas de stats en PDF (array de {value, label, color})
function rStatCells(doc, stats, y, cellH = 20) {
  const W = doc.internal.pageSize.getWidth();
  const cellW = (W - 28) / stats.length;
  stats.forEach((st, i) => {
    const x = 14 + i * cellW;
    doc.setFillColor(...st.color);
    doc.roundedRect(x, y, cellW - 2, cellH, 2.5, 2.5, 'F');
    doc.setTextColor(...R_WHITE);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text(String(st.value), x + (cellW - 2) / 2, y + cellH * 0.55, { align: 'center' });
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    doc.text(st.label, x + (cellW - 2) / 2, y + cellH - 3, { align: 'center' });
  });
  return y + cellH + 6;
}


// ════════════════════════════════════════════════════════════
// 1. REPORTE DE EVACUACIÓN
// ════════════════════════════════════════════════════════════
async function generateEvacuationReport() {
  if (!state.currentClassroom) { showToast('Selecciona un salón primero'); return; }
  showToast('Generando reporte de evacuación…');
  try {
    const cls   = state.currentClassroom;
    const today = todayISO();

    const [studSnap, sessSnap] = await Promise.all([
      db.collection('classrooms').doc(cls.id).collection('students').orderBy('name').get(),
      db.collection('classrooms').doc(cls.id).collection('sessions').orderBy('date','desc').limit(5).get(),
    ]);
    const allStudents = studSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (allStudents.length === 0) { showToast('Este salón no tiene alumnos registrados'); return; }

    const todaySess = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .find(s => isoFromTimestamp(s.date) === today);

    const presentStudents = todaySess
      ? allStudents.filter(s => !getAbsentIds(todaySess).includes(s.id))
      : allStudents;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // QR del salón (identifica el salón en caso de emergencia)
    const qrText = `AsistApp | ${cls.name}${cls.subject ? ' · ' + cls.subject : ''} | Evacuación ${today}`;
    const qrDataURL = await generateQRDataURL(qrText, 180);

    // Header de emergencia
    doc.setFillColor(220, 38, 38);
    doc.rect(0, 0, 210, 38, 'F');
    doc.setTextColor(...R_WHITE);
    doc.setFontSize(26); doc.setFont('helvetica', 'bold');
    doc.text('EVACUACIÓN — LISTA DE PRESENTES', 105, 15, { align: 'center' });
    doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    doc.text(`${cls.name}  ·  ${new Date().toLocaleString('es-ES', { dateStyle:'full', timeStyle:'short' })}`, 105, 26, { align: 'center' });
    if (!todaySess) {
      doc.setFontSize(9);
      doc.text('⚠ Sin asistencia registrada hoy — se listan TODOS los alumnos', 105, 34, { align: 'center' });
    }

    let y = 46;
    const total   = allStudents.length;
    const present = presentStudents.length;
    const absent  = total - present;

    y = rStatCells(doc, [
      { value: present, label: 'PRESENTES', color: R_GREEN },
      { value: absent,  label: 'AUSENTES',  color: R_RED   },
      { value: total,   label: 'TOTAL',     color: R_PRIMARY },
    ], y, 22);

    // Lista de presentes en 2 columnas
    const col1 = presentStudents.filter((_, i) => i % 2 === 0);
    const col2 = presentStudents.filter((_, i) => i % 2 === 1);

    doc.autoTable({
      head: [['#', 'Nombre del Alumno', '#', 'Nombre del Alumno']],
      body: col1.map((s, i) => [
        presentStudents.indexOf(s) + 1, s.name,
        col2[i] ? presentStudents.indexOf(col2[i]) + 1 : '',
        col2[i] ? col2[i].name : '',
      ]),
      startY: y,
      margin: { left: 14, right: 14 },
      headStyles: { fillColor: R_GREEN, textColor: R_WHITE, fontSize: 10, fontStyle: 'bold' },
      bodyStyles: { fontSize: 12, textColor: R_DARK, cellPadding: 3 },
      alternateRowStyles: { fillColor: [240, 253, 244] },
      columnStyles: {
        0: { cellWidth: 12, halign: 'center' },
        1: { cellWidth: 81 },
        2: { cellWidth: 12, halign: 'center' },
        3: { cellWidth: 81 },
      },
    });

    // QR en esquina inferior derecha de la primera página
    if (qrDataURL) {
      doc.setPage(1);
      doc.addImage(qrDataURL, 'PNG', 168, 270, 28, 28);
      doc.setFontSize(6.5); doc.setTextColor(...R_GRAY);
      doc.text('Identificación\ndel salón', 182, 268, { align: 'center' });
    }

    const pages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(7.5); doc.setTextColor(...R_GRAY);
      doc.text(`AsistApp · Evacuación · ${new Date().toLocaleDateString('es-ES')} · Pág ${p}/${pages}`, 105, 300, { align: 'center' });
    }

    doc.save(`Evacuacion_${rSafeFilename(cls.name)}_${today}.pdf`);
    showToast('Reporte de evacuación descargado ✓');
  } catch (e) {
    console.error('[Evacuación]', e);
    showToast('⚠️ Error al generar reporte de evacuación' + (e?.message ? ': ' + e.message : ' — revisa tu conexión'));
  }
}


// ════════════════════════════════════════════════════════════
// 2. RESUMEN SEMANAL PDF
// ════════════════════════════════════════════════════════════
async function generateWeeklyPDF() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  const weekInput = document.getElementById('rpt-week-input');
  const weekStartISO = weekInput ? weekInput.value : (() => {
    const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1);
    return toLocalISO(d);
  })();
  if (!weekStartISO) { showToast('Selecciona una semana'); return; }

  showToast('Generando resumen semanal PDF…');
  try {
    const cls      = state.currentClassroom;
    const weekStart = new Date(weekStartISO + 'T00:00:00');
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart); d.setDate(d.getDate() + i);
      return toLocalISO(d);
    });

    const { students, sessions } = await rFetchData(cls.id);
    const weekSessions = sessions.filter(s => {
      const iso = isoFromTimestamp(s.date);
      return iso >= days[0] && iso <= days[6];
    });

    if (weekSessions.length === 0) { showToast('No hay clases en esta semana'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = 297;

    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    const weekLabel = `${weekStart.toLocaleDateString('es-ES',{day:'numeric',month:'short'})} – ${weekEnd.toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})}`;
    rHeader(doc, 'Resumen Semanal de Asistencia', weekLabel);

    let y = rClassroomBlock(doc, cls, 38);

    // Tabla
    const sessionCols = weekSessions.map(s =>
      tsToDate(s.date).toLocaleDateString('es-ES', { weekday:'short', day:'numeric', month:'short' })
    );
    const head = [['#', 'Alumno', ...sessionCols, 'Pres.', 'Aus.', '%']];
    const body = students.map((st, i) => {
      let absent = 0;
      const row = [i + 1, st.name];
      weekSessions.forEach(s => { const m = rMark(s, st.id); if (m === 'A') absent++; row.push(m); });
      const pct = rPct(weekSessions.length - absent, weekSessions.length);
      row.push(weekSessions.length - absent, absent, pct + '%');
      return row;
    });
    // Fila total
    const totRow = ['', 'TOTAL'];
    weekSessions.forEach(s => {
      const ab = students.filter(st => getAbsentIds(s).includes(st.id)).length;
      totRow.push(`${students.length - ab}P`);
    });
    totRow.push('', '', '');
    body.push(totRow);

    const sessColW = Math.min(28, Math.floor((W - 28 - 50 - 14 - 12 - 14) / weekSessions.length));

    doc.autoTable({
      head, body, startY: y, margin: { left: 14, right: 14 },
      headStyles: { fillColor: R_PRIMARY, textColor: R_WHITE, fontSize: 9, fontStyle: 'bold', halign: 'center' },
      bodyStyles: { fontSize: 9, textColor: R_DARK, halign: 'center' },
      alternateRowStyles: { fillColor: R_LIGHT },
      columnStyles: {
        0: { cellWidth: 10 },
        1: { cellWidth: 50, halign: 'left' },
        [weekSessions.length + 2]: { cellWidth: 14 },
        [weekSessions.length + 3]: { cellWidth: 12 },
        [weekSessions.length + 4]: { cellWidth: 16 },
      },
      didParseCell(data) {
        if (data.section !== 'body') return;
        if (data.cell.raw === 'A') { data.cell.styles.textColor = R_RED; data.cell.styles.fontStyle = 'bold'; }
        if (data.cell.raw === 'T') { data.cell.styles.textColor = R_YELLOW; data.cell.styles.fontStyle = 'bold'; }
        else if (data.cell.raw === 'P') { data.cell.styles.textColor = R_GREEN; }
        if (data.column.index === weekSessions.length + 4 && data.row.index < body.length - 1) {
          const pct = parseInt(data.cell.raw); if (!isNaN(pct)) data.cell.styles.textColor = rColorPct(pct);
        }
        if (data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [230, 235, 255];
        }
      },
    });

    rFooter(doc);
    doc.save(`Semanal_${rSafeFilename(cls.name)}_${weekStartISO}.pdf`);
    showToast('Resumen semanal PDF descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 3. RESUMEN SEMANAL EXCEL
// ════════════════════════════════════════════════════════════
async function generateWeeklyExcel() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  const weekInput = document.getElementById('rpt-week-input');
  const weekStartISO = weekInput ? weekInput.value : (() => {
    const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1);
    return toLocalISO(d);
  })();
  if (!weekStartISO) { showToast('Selecciona una semana'); return; }

  showToast('Generando resumen semanal Excel…');
  try {
    const cls      = state.currentClassroom;
    const weekStart = new Date(weekStartISO + 'T00:00:00');
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart); d.setDate(d.getDate() + i);
      return toLocalISO(d);
    });

    const { students, sessions } = await rFetchData(cls.id);
    const weekSessions = sessions.filter(s => {
      const iso = isoFromTimestamp(s.date); return iso >= days[0] && iso <= days[6];
    });
    if (weekSessions.length === 0) { showToast('No hay clases en esta semana'); return; }

    const wb = XLSX.utils.book_new();

    // Hoja matriz
    const sHeaders = weekSessions.map(s =>
      tsToDate(s.date).toLocaleDateString('es-ES', { weekday:'short', day:'numeric', month:'short' })
    );
    const rows = students.map((st, i) => {
      let absent = 0;
      const cells = [i + 1, st.name];
      weekSessions.forEach(s => { const m = rMark(s, st.id); if (m === 'A') absent++; cells.push(m); });
      cells.push(weekSessions.length - absent, absent, rPct(weekSessions.length - absent, weekSessions.length) + '%');
      return cells;
    });
    const ws = XLSX.utils.aoa_to_sheet([
      [`Resumen Semanal — ${cls.name}`],
      [`Semana del ${weekStartISO} al ${days[6]}`],
      [],
      ['#', 'Alumno', ...sHeaders, 'Presencias', 'Ausencias', 'Asistencia %'],
      ...rows,
    ]);
    ws['!cols'] = [{ wch:5 },{ wch:28 }, ...weekSessions.map(()=>({ wch:14 })), { wch:12 },{ wch:12 },{ wch:14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Semana');

    // Hoja clases
    const clsWs = XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Tema', 'Observaciones', 'Presentes', 'Ausentes'],
      ...weekSessions.map(s => {
        const ab = getAbsentIds(s).length; const tot = s.totalStudents || students.length;
        return [tsToDate(s.date).toLocaleDateString('es-ES'), s.topic||'Sin tema', s.notes||'', tot-ab, ab];
      }),
    ]);
    clsWs['!cols'] = [{ wch:14 },{ wch:32 },{ wch:32 },{ wch:12 },{ wch:12 }];
    XLSX.utils.book_append_sheet(wb, clsWs, 'Clases');

    XLSX.writeFile(wb, `Semanal_${rSafeFilename(cls.name)}_${weekStartISO}.xlsx`);
    showToast('Excel semanal descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 4. RESUMEN MENSUAL PDF
// ════════════════════════════════════════════════════════════
async function generateMonthlyPDF() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  const { month, year } = rGetMonthYear();
  showToast('Generando reporte mensual PDF…');
  try {
    const cls = state.currentClassroom;
    const monthLabel = new Date(year, month, 1)
      .toLocaleDateString('es-ES', { month:'long', year:'numeric' });
    const capLabel = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

    const { students, sessions } = await rFetchData(cls.id);
    const monthSessions = sessions.filter(s => {
      const d = tsToDate(s.date);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    if (monthSessions.length === 0) { showToast('No hay clases en este mes'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = 297;

    rHeader(doc, 'Resumen Mensual de Asistencia', capLabel);
    let y = rClassroomBlock(doc, cls, 38);

    const sCols = monthSessions.map(s =>
      tsToDate(s.date).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit' })
    );
    const head = [['#', 'Alumno', ...sCols, 'Pres.', 'Aus.', '%']];
    const body = students.map((st, i) => {
      let absent = 0;
      const row = [i + 1, st.name];
      monthSessions.forEach(s => { const m = rMark(s, st.id); if (m === 'A') absent++; row.push(m); });
      const pct = rPct(monthSessions.length - absent, monthSessions.length);
      row.push(monthSessions.length - absent, absent, pct + '%');
      return row;
    });
    const totRow = ['', 'TOTAL'];
    monthSessions.forEach(s => {
      const ab = students.filter(st => getAbsentIds(s).includes(st.id)).length;
      totRow.push(students.length - ab);
    });
    totRow.push('', '', ''); body.push(totRow);

    const cw = Math.max(7, Math.min(15, Math.floor((W - 28 - 50 - 14 - 12 - 14) / monthSessions.length)));

    doc.autoTable({
      head, body, startY: y, margin: { left: 14, right: 14 },
      headStyles: { fillColor: R_PRIMARY, textColor: R_WHITE, fontSize: 8, fontStyle: 'bold', halign: 'center' },
      bodyStyles: { fontSize: 8, textColor: R_DARK, halign: 'center', cellPadding: 1.5 },
      alternateRowStyles: { fillColor: R_LIGHT },
      columnStyles: {
        0: { cellWidth: 8 },
        1: { cellWidth: 46, halign: 'left' },
        [monthSessions.length + 2]: { cellWidth: 14 },
        [monthSessions.length + 3]: { cellWidth: 12 },
        [monthSessions.length + 4]: { cellWidth: 14 },
      },
      didParseCell(data) {
        if (data.section !== 'body') return;
        if (data.cell.raw === 'A') { data.cell.styles.textColor = R_RED; data.cell.styles.fontStyle = 'bold'; }
        if (data.cell.raw === 'T') { data.cell.styles.textColor = R_YELLOW; data.cell.styles.fontStyle = 'bold'; }
        else if (data.cell.raw === 'P') { data.cell.styles.textColor = R_GREEN; }
        if (data.column.index === monthSessions.length + 4 && data.row.index < body.length - 1) {
          const pct = parseInt(data.cell.raw); if (!isNaN(pct)) data.cell.styles.textColor = rColorPct(pct);
        }
        if (data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [230, 235, 255];
        }
      },
    });

    rFooter(doc);
    doc.save(`Mensual_${rSafeFilename(cls.name)}_${year}_${String(month+1).padStart(2,'0')}.pdf`);
    showToast('Reporte mensual PDF descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 5. RESUMEN MENSUAL EXCEL
// ════════════════════════════════════════════════════════════
async function generateMonthlyExcel() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  const { month, year } = rGetMonthYear();
  showToast('Generando reporte mensual Excel…');
  try {
    const cls = state.currentClassroom;
    const monthLabel = new Date(year, month, 1)
      .toLocaleDateString('es-ES', { month:'long', year:'numeric' });
    const capLabel = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

    const { students, sessions } = await rFetchData(cls.id);
    const monthSessions = sessions.filter(s => {
      const d = tsToDate(s.date);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    if (monthSessions.length === 0) { showToast('No hay clases en este mes'); return; }

    const wb = XLSX.utils.book_new();
    const sH = monthSessions.map(s => tsToDate(s.date).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit' }));
    const rows = students.map((st, i) => {
      let absent = 0;
      const cells = [i + 1, st.name];
      monthSessions.forEach(s => { const m = rMark(s, st.id); if (m === 'A') absent++; cells.push(m); });
      cells.push(monthSessions.length - absent, absent, rPct(monthSessions.length - absent, monthSessions.length) + '%');
      return cells;
    });

    const ws = XLSX.utils.aoa_to_sheet([
      [`Reporte Mensual — ${cls.name}`],
      [capLabel],
      [],
      ['#', 'Alumno', ...sH, 'Presencias', 'Ausencias', 'Asistencia %'],
      ...rows,
    ]);
    ws['!cols'] = [{ wch:5 },{ wch:28 }, ...monthSessions.map(()=>({ wch:10 })),{ wch:12 },{ wch:12 },{ wch:14 }];
    XLSX.utils.book_append_sheet(wb, ws, capLabel.slice(0, 31));

    const clsWs = XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Tema', 'Observaciones', 'Presentes', 'Ausentes'],
      ...monthSessions.map(s => {
        const ab = getAbsentIds(s).length; const tot = s.totalStudents || students.length;
        return [tsToDate(s.date).toLocaleDateString('es-ES'), s.topic||'Sin tema', s.notes||'', tot-ab, ab];
      }),
    ]);
    clsWs['!cols'] = [{ wch:14 },{ wch:32 },{ wch:32 },{ wch:12 },{ wch:12 }];
    XLSX.utils.book_append_sheet(wb, clsWs, 'Clases');

    XLSX.writeFile(wb, `Mensual_${rSafeFilename(cls.name)}_${year}_${String(month+1).padStart(2,'0')}.xlsx`);
    showToast('Excel mensual descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 6. REPORTE INDIVIDUAL DE ALUMNO PDF (para padres)
// ════════════════════════════════════════════════════════════
async function generateStudentReportPDF(studentId) {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  showToast('Generando reporte del alumno…');
  try {
    const cls = state.currentClassroom;
    const [studDoc, sessSnap] = await Promise.all([
      db.collection('classrooms').doc(cls.id).collection('students').doc(studentId).get(),
      db.collection('classrooms').doc(cls.id).collection('sessions').orderBy('date','asc').get(),
    ]);
    if (!studDoc.exists) { showToast('Alumno no encontrado'); return; }
    const student  = { id: studDoc.id, ...studDoc.data() };
    const sessions = sessSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    rHeader(doc, 'Reporte Individual de Asistencia', new Date().toLocaleDateString('es-ES'));

    doc.setTextColor(...R_DARK);
    doc.setFontSize(20); doc.setFont('helvetica', 'bold');
    doc.text(student.name, 14, 42);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(...R_GRAY);
    const sub = `${cls.name}${cls.subject ? ' · ' + cls.subject : ''}`;
    doc.text(sub, 14, 50);

    const totalSess = sessions.length;
    const absences  = sessions.filter(s => getAbsentIds(s).includes(studentId)).length;
    const presents  = totalSess - absences;
    const pct       = rPct(presents, totalSess);

    let y = rStatCells(doc, [
      { value: presents,  label: 'PRESENCIAS', color: R_GREEN },
      { value: absences,  label: 'AUSENCIAS',  color: R_RED },
      { value: pct + '%', label: 'ASISTENCIA', color: rColorPct(pct) },
    ], 56, 20);

    // Alerta
    if (absences >= alertThreshold) {
      doc.setFillColor(255, 251, 235);
      doc.setDrawColor(...R_YELLOW); doc.setLineWidth(0.4);
      doc.roundedRect(14, y, 182, 10, 2, 2, 'FD');
      doc.setTextColor(...R_YELLOW); doc.setFontSize(9); doc.setFont('helvetica','bold');
      doc.text(`⚠  ${absences} ausencias — supera el umbral de ${alertThreshold} configurado`, 105, y + 6.5, { align: 'center' });
      y += 14;
    } else { y += 4; }

    // Historial
    doc.autoTable({
      head: [['Fecha', 'Tema', 'Estado', 'Justificación']],
      body: sessions.map(s => {
        const mark   = rMark(s, studentId);
        const absent = mark === 'A';
        const justif = absent ? (getJustification(s, studentId) || '—') : '—';
        return [
          tsToDate(s.date).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' }),
          s.topic || 'Sin tema',
          absent ? 'Ausente' : mark === 'T' ? 'Tarde' : 'Presente',
          justif,
        ];
      }),
      startY: y,
      margin: { left: 14, right: 14 },
      headStyles: { fillColor: R_PRIMARY, textColor: R_WHITE, fontSize: 9, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9, textColor: R_DARK },
      alternateRowStyles: { fillColor: R_LIGHT },
      columnStyles: { 0:{cellWidth:26}, 2:{cellWidth:22, halign:'center'}, 3:{cellWidth:52} },
      didParseCell(data) {
        if (data.section === 'body' && data.column.index === 2) {
          data.cell.styles.textColor = data.cell.raw === 'Ausente' ? R_RED
            : data.cell.raw === 'Tarde' ? R_YELLOW : R_GREEN;
          data.cell.styles.fontStyle = 'bold';
        }
      },
    });

    // Firma para padres
    const pages = doc.internal.getNumberOfPages();
    doc.setPage(pages);
    const sigY = (doc.previousAutoTable?.finalY || 240) + 18;
    if (sigY < 262) {
      doc.setFontSize(9); doc.setTextColor(...R_GRAY);
      doc.text('Firma del padre / representante:', 14, sigY);
      doc.setDrawColor(...R_GRAY); doc.setLineWidth(0.3);
      doc.line(14, sigY + 11, 92, sigY + 11);
      doc.text('Firma del docente:', 118, sigY);
      doc.line(118, sigY + 11, 196, sigY + 11);
    }

    rFooter(doc);
    doc.save(`Alumno_${rSafeFilename(student.name)}_${rFileDate()}.pdf`);
    showToast('Reporte de alumno descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 7. REPORTE DE ALERTAS / BAJO RENDIMIENTO PDF
// ════════════════════════════════════════════════════════════
async function generateLowAttendanceReport() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  showToast('Generando reporte de alertas…');
  try {
    const cls = state.currentClassroom;
    const { students, sessions } = await rFetchData(cls.id);
    if (sessions.length === 0) { showToast('No hay sesiones registradas'); return; }

    const studData = students.map(st => {
      const ab = sessions.filter(s => getAbsentIds(s).includes(st.id)).length;
      const pct = rPct(sessions.length - ab, sessions.length);
      return { ...st, absences: ab, presents: sessions.length - ab, pct };
    }).sort((a, b) => b.absences - a.absences);

    const atRisk = studData.filter(s => s.absences >= alertThreshold);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    rHeader(doc, 'Reporte de Alertas de Asistencia', new Date().toLocaleDateString('es-ES'));
    let y = rClassroomBlock(doc, cls, 38);

    // Banner resumen
    const bannerColor = atRisk.length > 0 ? [255, 237, 213] : [240, 253, 244];
    const bannerText  = atRisk.length > 0 ? [154, 52, 18] : [...R_GREEN];
    doc.setFillColor(...bannerColor);
    doc.roundedRect(14, y, 182, 12, 3, 3, 'F');
    doc.setTextColor(...bannerText); doc.setFontSize(10); doc.setFont('helvetica','bold');
    doc.text(
      atRisk.length > 0
        ? `⚠  ${atRisk.length} alumno${atRisk.length !== 1 ? 's' : ''} con ${alertThreshold}+ ausencias de ${sessions.length} clases`
        : `✓  Todos los alumnos están dentro del umbral (${alertThreshold} ausencias)`,
      105, y + 7.5, { align: 'center' }
    );
    y += 18;

    if (atRisk.length > 0) {
      doc.setFontSize(10); doc.setFont('helvetica','bold'); doc.setTextColor(...R_DARK);
      doc.text('Alumnos en riesgo:', 14, y); y += 5;
      doc.autoTable({
        head: [['#', 'Alumno', 'Ausencias', 'Presencias', 'Asistencia %', 'Nivel']],
        body: atRisk.map((st, i) => [
          i + 1, st.name, st.absences, st.presents, st.pct + '%',
          st.pct < 60 ? '🔴 Crítico' : st.pct < 75 ? '🟡 Bajo' : '🟠 En riesgo',
        ]),
        startY: y,
        margin: { left: 14, right: 14 },
        headStyles: { fillColor: R_RED, textColor: R_WHITE, fontSize: 9, fontStyle: 'bold' },
        bodyStyles: { fontSize: 9, textColor: R_DARK },
        alternateRowStyles: { fillColor: [255, 245, 245] },
        columnStyles: { 0:{cellWidth:10,halign:'center'}, 2:{cellWidth:22,halign:'center'}, 3:{cellWidth:22,halign:'center'}, 4:{cellWidth:24,halign:'center'}, 5:{cellWidth:28} },
        didParseCell(data) {
          if (data.section === 'body') {
            if (data.column.index === 2) { data.cell.styles.textColor = R_RED; data.cell.styles.fontStyle = 'bold'; }
            if (data.column.index === 4) { const p=parseInt(data.cell.raw); if(!isNaN(p)) data.cell.styles.textColor = rColorPct(p); }
          }
        },
      });
      y = (doc.previousAutoTable?.finalY || y) + 12;
    }

    // Tabla completa del grupo
    if (y < 225) {
      doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(...R_DARK);
      doc.text('Resumen completo del grupo:', 14, y); y += 5;
      doc.autoTable({
        head: [['#', 'Alumno', 'Aus.', 'Pres.', 'Asist. %']],
        body: studData.map((st, i) => [i+1, st.name, st.absences, st.presents, st.pct+'%']),
        startY: y,
        margin: { left: 14, right: 14 },
        headStyles: { fillColor: R_DARK, textColor: R_WHITE, fontSize: 8, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: R_DARK },
        alternateRowStyles: { fillColor: R_LIGHT },
        columnStyles: { 0:{cellWidth:10,halign:'center'}, 2:{cellWidth:14,halign:'center'}, 3:{cellWidth:14,halign:'center'}, 4:{cellWidth:18,halign:'center'} },
        didParseCell(data) {
          if (data.section === 'body') {
            if (data.column.index === 4) { const p=parseInt(data.cell.raw); if(!isNaN(p)) data.cell.styles.textColor = rColorPct(p); }
            const st = studData[data.row.index];
            if (st && st.absences >= alertThreshold) data.cell.styles.fillColor = [255, 248, 248];
          }
        },
      });
    }

    rFooter(doc);
    doc.save(`Alertas_${rSafeFilename(cls.name)}_${rFileDate()}.pdf`);
    showToast('Reporte de alertas descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 7.5 RANKING DE FALTAS POR ALUMNO (histórico completo)
// ════════════════════════════════════════════════════════════
async function generateAbsenceRankingReport() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  showToast('Generando ranking de faltas…');
  try {
    const cls = state.currentClassroom;
    const { students, sessions } = await rFetchData(cls.id);
    if (sessions.length === 0) { showToast('No hay sesiones registradas'); return; }

    // students ya viene ordenado por nombre (= número de lista de la planilla);
    // no se reordena por cantidad de faltas para mantener ese orden.
    const studData = students.map(st => {
      const ab = sessions.filter(s => getAbsentIds(s).includes(st.id)).length;
      const pct = rPct(sessions.length - ab, sessions.length);
      return { ...st, absences: ab, presents: sessions.length - ab, pct };
    });

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    rHeader(doc, 'Ranking de Faltas por Alumno', new Date().toLocaleDateString('es-ES'));
    let y = rClassroomBlock(doc, cls, 38);

    doc.setFillColor(...R_LIGHT);
    doc.roundedRect(14, y, 182, 10, 3, 3, 'F');
    doc.setTextColor(...R_DARK); doc.setFontSize(9); doc.setFont('helvetica','bold');
    doc.text(`Historial completo · ${sessions.length} clase${sessions.length !== 1 ? 's' : ''} registrada${sessions.length !== 1 ? 's' : ''}`, 105, y + 6.5, { align: 'center' });
    y += 16;

    doc.autoTable({
      head: [['#', 'Alumno', 'Faltas', 'Presencias', 'Asistencia %']],
      body: studData.map((st, i) => [i + 1, st.name, st.absences, st.presents, st.pct + '%']),
      startY: y,
      margin: { left: 14, right: 14 },
      headStyles: { fillColor: R_PRIMARY, textColor: R_WHITE, fontSize: 9, fontStyle: 'bold' },
      bodyStyles: { fontSize: 9, textColor: R_DARK },
      alternateRowStyles: { fillColor: R_LIGHT },
      columnStyles: { 0:{cellWidth:10,halign:'center'}, 2:{cellWidth:24,halign:'center'}, 3:{cellWidth:26,halign:'center'}, 4:{cellWidth:28,halign:'center'} },
      didParseCell(data) {
        if (data.section === 'body') {
          if (data.column.index === 2) { data.cell.styles.textColor = R_RED; data.cell.styles.fontStyle = 'bold'; }
          if (data.column.index === 4) { const p=parseInt(data.cell.raw); if(!isNaN(p)) data.cell.styles.textColor = rColorPct(p); }
        }
      },
    });

    rFooter(doc);
    doc.save(`Ranking_Faltas_${rSafeFilename(cls.name)}_${rFileDate()}.pdf`);
    showToast('Ranking de faltas descargado ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// 8. EXPORTACIÓN COMPLETA EXCEL
// ════════════════════════════════════════════════════════════
async function generateFullExport() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  showToast('Generando exportación completa…');
  try {
    const cls = state.currentClassroom;
    const { students, sessions } = await rFetchData(cls.id);

    const wb = XLSX.utils.book_new();

    // Hoja 1 — Resumen
    const totalAbs   = sessions.reduce((a, s) => a + getAbsentIds(s).length, 0);
    const totalSlots = sessions.length * students.length;
    const overallPct = rPct(totalSlots - totalAbs, totalSlots);
    const resWs = XLSX.utils.aoa_to_sheet([
      ['AsistApp — Exportación Completa'],
      [`Salón: ${cls.name}`],
      [`Materia: ${cls.subject || '—'}`],
      [`Nivel / Grado: ${cls.grade || '—'}`],
      [`Exportado el: ${new Date().toLocaleDateString('es-ES')}`],
      [],
      ['Total alumnos',  students.length],
      ['Total clases',   sessions.length],
      ['Total ausencias',totalAbs],
      ['Asistencia general', overallPct + '%'],
    ]);
    XLSX.utils.book_append_sheet(wb, resWs, 'Resumen');

    // Hoja 2 — Alumnos
    const studWs = XLSX.utils.aoa_to_sheet([
      ['#', 'Nombre', 'Ausencias', 'Presencias', 'Asistencia %'],
      ...students.map((st, i) => {
        const ab = sessions.filter(s => getAbsentIds(s).includes(st.id)).length;
        return [i+1, st.name, ab, sessions.length-ab, rPct(sessions.length-ab,sessions.length)+'%'];
      }),
    ]);
    studWs['!cols'] = [{ wch:5 },{ wch:30 },{ wch:12 },{ wch:12 },{ wch:14 }];
    XLSX.utils.book_append_sheet(wb, studWs, 'Alumnos');

    // Hoja 3 — Sesiones
    const sessWs = XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Tema', 'Observaciones', 'Total', 'Presentes', 'Ausentes', 'Asistencia %'],
      ...sessions.map(s => {
        const ab  = getAbsentIds(s).length;
        const tot = s.totalStudents || students.length;
        return [tsToDate(s.date).toLocaleDateString('es-ES'), s.topic||'Sin tema', s.notes||'', tot, tot-ab, ab, rPct(tot-ab,tot)+'%'];
      }),
    ]);
    sessWs['!cols'] = [{ wch:14 },{ wch:32 },{ wch:32 },{ wch:8 },{ wch:10 },{ wch:10 },{ wch:12 }];
    XLSX.utils.book_append_sheet(wb, sessWs, 'Sesiones');

    // Hoja 4 — Matriz completa
    if (sessions.length > 0 && students.length > 0) {
      const sH = sessions.map(s => tsToDate(s.date).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit' }));
      const matRows = students.map((st, i) => {
        let ab = 0;
        const cells = [i+1, st.name];
        sessions.forEach(s => { const m = rMark(s, st.id); if (m === 'A') ab++; cells.push(m); });
        cells.push(sessions.length-ab, ab, rPct(sessions.length-ab,sessions.length)+'%');
        return cells;
      });
      const matWs = XLSX.utils.aoa_to_sheet([
        ['#', 'Alumno', ...sH, 'Presencias', 'Ausencias', '%'],
        ...matRows,
      ]);
      matWs['!cols'] = [{ wch:5 },{ wch:28 }, ...sessions.map(()=>({ wch:8 })),{ wch:12 },{ wch:12 },{ wch:12 }];
      XLSX.utils.book_append_sheet(wb, matWs, 'Matriz Completa');
    }

    XLSX.writeFile(wb, `Exportacion_${rSafeFilename(cls.name)}_${rFileDate()}.xlsx`);
    showToast('Exportación completa descargada ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}


// ════════════════════════════════════════════════════════════
// VISTA DE REPORTES — Helpers de UI
// ════════════════════════════════════════════════════════════
function rGetMonthYear() {
  const sel = document.getElementById('rpt-month-sel');
  if (sel && sel.value) {
    const [y, m] = sel.value.split('-').map(Number);
    return { month: m - 1, year: y };
  }
  const now = new Date();
  return { month: now.getMonth(), year: now.getFullYear() };
}

// ════════════════════════════════════════════════════════════
// 9. LISTA EN BLANCO IMPRIMIBLE (pase de lista manual)
// ════════════════════════════════════════════════════════════
async function generateBlankAttendancePDF() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  showToast('Generando lista en blanco…');
  try {
    const cls = state.currentClassroom;
    const snap = await db.collection('classrooms').doc(cls.id)
      .collection('students').orderBy('name').get();
    const students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (students.length === 0) { showToast('No hay alumnos en este salón'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // Generar QR para identificar el salón
    const qrText = `AsistApp | ${cls.name}${cls.subject ? ' · ' + cls.subject : ''}`;
    const qrDataURL = await generateQRDataURL(qrText, 180);

    // ── Header ──────────────────────────────────────────────
    doc.setFillColor(...R_PRIMARY);
    doc.rect(0, 0, 210, 28, 'F');
    doc.setTextColor(...R_WHITE);
    doc.setFontSize(18); doc.setFont('helvetica', 'bold');
    doc.text('AsistApp — Pase de Lista', 14, 12);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text('Lista para registro manual de asistencia', 14, 20);

    // QR en el header
    if (qrDataURL) doc.addImage(qrDataURL, 'PNG', 186, 2, 20, 20);

    // ── Info del salón ───────────────────────────────────────
    doc.setTextColor(...R_DARK);
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text(cls.name, 14, 40);
    const sub = [cls.subject, cls.grade].filter(Boolean).join(' · ');
    if (sub) {
      doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(...R_GRAY);
      doc.text(sub, 14, 47);
    }

    // ── Campos de fecha y tema ───────────────────────────────
    let y = 54;
    const fieldY = y;
    doc.setFillColor(...R_LIGHT);
    doc.roundedRect(14, y, 88, 14, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...R_GRAY);
    doc.text('FECHA', 18, y + 5);
    doc.setDrawColor(...R_GRAY); doc.setLineWidth(0.3);
    doc.line(18, y + 11, 98, y + 11);

    doc.setFillColor(...R_LIGHT);
    doc.roundedRect(108, y, 88, 14, 2, 2, 'F');
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(...R_GRAY);
    doc.text('TEMA DE LA CLASE', 112, y + 5);
    doc.line(112, y + 11, 192, y + 11);
    y += 20;

    // ── Tabla de alumnos ─────────────────────────────────────
    // Dos columnas para aprovechar el espacio
    const mid       = Math.ceil(students.length / 2);
    const col1      = students.slice(0, mid);
    const col2      = students.slice(mid);
    const maxRows   = Math.max(col1.length, col2.length);

    const tableBody = [];
    for (let i = 0; i < maxRows; i++) {
      const s1 = col1[i];
      const s2 = col2[i];
      tableBody.push([
        i + 1,
        s1 ? s1.name : '',
        '',   // checkbox P col1
        '',   // checkbox A col1
        '',   // separador
        s2 ? i + mid + 1 : '',
        s2 ? s2.name : '',
        '',   // checkbox P col2
        '',   // checkbox A col2
      ]);
    }

    doc.autoTable({
      head: [['#', 'Alumno', 'P', 'A', ' ', '#', 'Alumno', 'P', 'A']],
      body: tableBody,
      startY: y,
      margin: { left: 14, right: 14 },
      headStyles: {
        fillColor: R_PRIMARY, textColor: R_WHITE,
        fontSize: 9, fontStyle: 'bold', halign: 'center',
      },
      bodyStyles: { fontSize: 9.5, textColor: R_DARK, cellPadding: 3 },
      alternateRowStyles: { fillColor: R_LIGHT },
      columnStyles: {
        0: { cellWidth: 8,  halign: 'center' },
        1: { cellWidth: 58 },
        2: { cellWidth: 8,  halign: 'center' },
        3: { cellWidth: 8,  halign: 'center' },
        4: { cellWidth: 6,  fillColor: [230,232,240] },
        5: { cellWidth: 8,  halign: 'center' },
        6: { cellWidth: 58 },
        7: { cellWidth: 8,  halign: 'center' },
        8: { cellWidth: 8,  halign: 'center' },
      },
      didDrawCell(data) {
        // Dibujar casillas □ en columnas P y A
        if (data.section === 'body' && [2, 3, 7, 8].includes(data.column.index)) {
          const x = data.cell.x + (data.cell.width  - 5) / 2;
          const yy = data.cell.y + (data.cell.height - 5) / 2;
          doc.setDrawColor(...R_GRAY); doc.setLineWidth(0.35);
          doc.rect(x, yy, 5, 5);
        }
      },
    });

    // ── Totales y firma ──────────────────────────────────────
    const finalY = (doc.previousAutoTable?.finalY || 240) + 8;
    if (finalY < 265) {
      doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...R_GRAY);
      doc.text('Total alumnos: ______', 14, finalY);
      doc.text('Presentes: ______', 65, finalY);
      doc.text('Ausentes: ______', 112, finalY);

      doc.line(14, finalY + 14, 80, finalY + 14);
      doc.text('Firma del docente', 47, finalY + 18, { align: 'center' });
    }

    // ── Pie de página ────────────────────────────────────────
    const pages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(7.5); doc.setTextColor(...R_GRAY);
      doc.text(`AsistApp · Lista en blanco · ${new Date().toLocaleDateString('es-ES')} · Pág ${p}/${pages}`, 105, 295, { align: 'center' });
    }

    doc.save(`ListaEnBlanco_${rSafeFilename(cls.name)}_${rFileDate()}.pdf`);
    showToast('Lista en blanco descargada ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}

// ════════════════════════════════════════════════════════════
// HOJA DE CONTROL DE INASISTENCIA (formato oficial)
// Réplica del documento físico, llenado automático:
//  · FECHA de cada clase     · punto (•) por alumno ausente
//  · MATERIA VISTA = tema    · 13 clases por hoja (la 14 → hoja nueva)
// ════════════════════════════════════════════════════════════
function rVTextCentered(doc, text, x, y, w, h) {
  // Texto vertical (de abajo hacia arriba) centrado en la caja (x,y,w,h)
  const tw = doc.getTextWidth(text);
  const cx = x + w / 2 + 1.3;       // centrado horizontal (alto de fuente ~)
  const cy = y + h / 2 + tw / 2;    // centrado vertical
  doc.text(text, cx, cy, { angle: 90 });
}

function openInasistenciaPeriodo() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  const f = document.getElementById('inas-from');
  const t = document.getElementById('inas-to');
  if (f) f.value = '';
  if (t) t.value = '';
  openModal('modal-inasistencia-periodo');
}

async function generateInasistenciaSheet() {
  if (!state.currentClassroom) { showToast('Selecciona un salón'); return; }
  closeModal('modal-inasistencia-periodo');
  // Periodo seleccionado (opcional)
  const fromEl = document.getElementById('inas-from');
  const toEl   = document.getElementById('inas-to');
  const fromTs = fromEl && fromEl.value ? new Date(fromEl.value + 'T00:00:00').getTime() : null;
  const toTs   = toEl && toEl.value ? new Date(toEl.value + 'T23:59:59').getTime() : null;
  showToast('Generando hoja de inasistencia…');
  try {
    const cls = state.currentClassroom;
    let { students, sessions } = await rFetchData(cls.id); // sessions asc por fecha
    // Filtrar por periodo de clase si se indicó
    if (fromTs || toTs) {
      sessions = sessions.filter(s => {
        const t = tsToDate(s.date).getTime();
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
        return true;
      });
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });

    // ── Geometría (mm) ───────────────────────────────────────
    const LIST_ROWS = 48, MARK_COLS = 13, MID_ROWS = 13, EVAL_ROWS = 15;
    const ax = 10;                 // margen izquierdo
    const titW = 5, numW = 6, markW = 3.4;   // titW: etiqueta vertical; numW: números 1-48
    const aRight = ax + titW + numW + MARK_COLS * markW;
    const bx = aRight + 3;
    const fechaW = 7, objW = 7, matW = 24;
    const bRight = bx + fechaW + objW + matW;
    const cx0 = bRight + 3;
    const cRight = 205.9;          // margen derecho (215.9 - 10)
    const cW = cRight - cx0;
    const eN = 7, eEstr = 34, eFecha = 17, ePct = 9;
    const eObs = cW - (eN + eEstr + eFecha + ePct);

    const yTitle = 12, titleH = 5;
    const yBand = yTitle + titleH;        // 17
    const bandH = 24;
    const yBody = yBand + bandH;          // 41
    const yBottom = 266;
    const rowH = (yBottom - yBody) / LIST_ROWS;
    const midRowH = (yBottom - yBody) / MID_ROWS;

    const BLACK = [0, 0, 0], GRAY = [217, 217, 217];

    const fmtDate = ts => { const d = tsToDate(ts);
      return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2); };

    // Dividir las clases en hojas de 13
    const pages = [];
    for (let i = 0; i < Math.max(sessions.length, 1); i += MARK_COLS)
      pages.push(sessions.slice(i, i + MARK_COLS));

    pages.forEach((pageSessions, pIdx) => {
      if (pIdx > 0) doc.addPage();
      doc.setDrawColor(...BLACK); doc.setLineWidth(0.2);

      const titleBar = (x, w, txt) => {
        doc.setFillColor(...GRAY); doc.rect(x, yTitle, w, titleH, 'FD');
        doc.setTextColor(...BLACK); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
        doc.text(txt, x + w / 2, yTitle + 3.6, { align: 'center' });
      };

      // ───────── BLOQUE A: CONTROL DE INASISTENCIA ─────────
      titleBar(ax, aRight - ax, 'CONTROL DE INASITENCIA');
      // marco
      doc.rect(ax, yBand, aRight - ax, yBottom - yBand);
      // líneas verticales
      const numX = ax + titW;                 // inicio columna de números
      const gridX = numX + numW;              // inicio de las casillas de marca
      doc.line(numX, yBand, numX, yBottom);   // separa título vertical / números
      doc.line(gridX, yBand, gridX, yBottom); // separa números / casillas
      for (let c = 1; c <= MARK_COLS; c++) {
        const x = gridX + c * markW;
        doc.line(x, yBand, x, yBottom);
      }
      // líneas horizontales (banda + filas)
      doc.line(ax, yBody, aRight, yBody);
      for (let r = 1; r <= LIST_ROWS; r++) {
        const y = yBody + r * rowH;
        doc.line(ax, y, aRight, y);
      }
      // etiqueta vertical "NÚMERO DE LISTA" (columna propia, toda la altura)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
      rVTextCentered(doc, 'NÚMERO DE LISTA', ax, yBand, titW, yBottom - yBand);
      // fechas por columna (banda superior)
      doc.setFontSize(6.5);
      pageSessions.forEach((s, c) => {
        const x = gridX + c * markW;
        rVTextCentered(doc, fmtDate(s.date), x, yBand, markW, bandH);
      });
      // números 1..48
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6);
      for (let r = 1; r <= LIST_ROWS; r++) {
        doc.text(String(r), numX + numW / 2, yBody + (r - 0.5) * rowH + 1, { align: 'center' });
      }
      // puntos de inasistencia
      doc.setFillColor(...BLACK);
      students.forEach((st, sIdx) => {
        if (sIdx >= LIST_ROWS) return;
        pageSessions.forEach((s, c) => {
          if (getAbsentIds(s).includes(st.id)) {
            const cxDot = gridX + (c + 0.5) * markW;
            const cyDot = yBody + (sIdx + 0.5) * rowH;
            doc.circle(cxDot, cyDot, 0.8, 'F');
          }
        });
      });

      // ───────── BLOQUE B: FECHA / # OBJETIVO / MATERIA ─────────
      doc.setDrawColor(...BLACK);
      doc.rect(bx, yBand, bRight - bx, yBottom - yBand);
      doc.line(bx + fechaW, yBand, bx + fechaW, yBottom);
      doc.line(bx + fechaW + objW, yBand, bx + fechaW + objW, yBottom);
      doc.line(bx, yBody, bRight, yBody);
      for (let r = 1; r <= MID_ROWS; r++) {
        const y = yBody + r * midRowH; doc.line(bx, y, bRight, y);
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
      rVTextCentered(doc, 'FECHA', bx, yBand, fechaW, bandH);
      rVTextCentered(doc, '# DE OBJETIVO', bx + fechaW, yBand, objW, bandH);
      rVTextCentered(doc, 'MATERIA VISTA', bx + fechaW + objW, yBand, matW, bandH);
      // datos por clase
      doc.setFont('helvetica', 'normal');
      pageSessions.forEach((s, r) => {
        const yMid = yBody + r * midRowH;
        doc.setFontSize(7);
        // Solo la FECHA se llena; # OBJETIVO y MATERIA VISTA quedan en blanco.
        rVTextCentered(doc, fmtDate(s.date), bx, yMid, fechaW, midRowH);
      });

      // ───────── BLOQUE C: RESUMEN DEL PLAN EVALUATIVO ─────────
      doc.setDrawColor(...BLACK);
      titleBar(cx0, cW, 'RESUMEN DEL PLAN EVALUATIVO');
      const evalBottom = yBody + EVAL_ROWS * 6;
      const evalRowH = 6;
      doc.rect(cx0, yBand, cW, evalBottom - yBand);
      const exs = [cx0 + eN, cx0 + eN + eEstr, cx0 + eN + eEstr + eFecha, cx0 + eN + eEstr + eFecha + ePct];
      exs.forEach(x => doc.line(x, yBand, x, evalBottom));
      doc.line(cx0, yBody, cRight, yBody);
      for (let r = 1; r <= EVAL_ROWS; r++) {
        const y = yBody + r * evalRowH; doc.line(cx0, y, cRight, y);
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
      doc.text('Nº', cx0 + eN / 2, yBand + bandH / 2, { align: 'center' });
      rVTextCentered(doc, 'ESTRATEGIA', cx0 + eN, yBand, eEstr, bandH);
      rVTextCentered(doc, 'FECHA', cx0 + eN + eEstr, yBand, eFecha, bandH);
      rVTextCentered(doc, '%', cx0 + eN + eEstr + eFecha, yBand, ePct, bandH);
      rVTextCentered(doc, 'OBSERVACIÓN', cx0 + eN + eEstr + eFecha + ePct, yBand, eObs, bandH);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
      for (let r = 1; r <= EVAL_ROWS; r++) {
        doc.text(String(r), cx0 + eN / 2, yBody + (r - 0.5) * evalRowH + 1, { align: 'center' });
      }

      // ───────── RESUMEN DEL LAPSO ─────────
      const lapsoY = evalBottom + 8, lapsoRowH = 5, lapsoValW = 26;
      const labels = [
        'TOTAL DE CLASES PROGRAMADAS', 'TOTAL DE CLASES DADAS', '% CLASES DADAS',
        'TOTAL DE OBJETIVOS PROGRAMADOS', 'TOTAL DE OBJETIVOS DADOS', '%OBJETIVOS DADOS',
        'TOTAL DE ALUMNOS', 'TOTAL DE ALUMNOS APROBADOS', '% DE ALUMNOS APROBADOS',
        'TOTAL DE ALUMNOS  APLAZADOS', '% ALUMNOS APLAZADOS',
      ];
      titleBar2(doc, cx0, lapsoY, cW, 'RESUMEN DEL LAPSO', GRAY, BLACK);
      const lapsoBodyY = lapsoY + lapsoRowH;
      doc.rect(cx0, lapsoBodyY, cW, labels.length * lapsoRowH);
      doc.line(cRight - lapsoValW, lapsoBodyY, cRight - lapsoValW, lapsoBodyY + labels.length * lapsoRowH);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6);
      labels.forEach((l, i) => {
        const y = lapsoBodyY + i * lapsoRowH;
        if (i > 0) doc.line(cx0, y, cRight, y);
        doc.text(l, cx0 + (cW - lapsoValW) / 2, y + lapsoRowH / 2 + 0.8, { align: 'center' });
      });
      // valores que sí conocemos
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      const valX = cRight - lapsoValW / 2;
      const putVal = (idx, val) => doc.text(String(val), valX, lapsoBodyY + idx * lapsoRowH + lapsoRowH / 2 + 0.8, { align: 'center' });
      putVal(1, sessions.length);          // TOTAL DE CLASES DADAS

      // ───────── DOCENTE ─────────
      const docY = lapsoBodyY + labels.length * lapsoRowH + 10;
      titleBar2(doc, cx0, docY, cW, 'DOCENTE', GRAY, BLACK);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...BLACK);
      const fy = docY + 12;
      [['NOMBRES:', 0], ['APELLIDOS:', 10], ['FIRMA:', 20]].forEach(([lab, dy]) => {
        doc.text(lab, cx0, fy + dy);
        doc.line(cx0 + 22, fy + dy, cRight, fy + dy);
      });
    });

    doc.save(`Inasistencia_${rSafeFilename(cls.name)}_${rFileDate()}.pdf`);
    showToast('Hoja de inasistencia descargada ✓');
  } catch (e) { console.error(e); showToast('Error: ' + e.message); }
}

// barra de título reutilizable en una posición y arbitraria
function titleBar2(doc, x, y, w, txt, fill, text) {
  doc.setDrawColor(...text); doc.setLineWidth(0.2);
  doc.setFillColor(...fill); doc.rect(x, y, w, 5, 'FD');
  doc.setTextColor(...text); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
  doc.text(txt, x + w / 2, y + 3.6, { align: 'center' });
}

function loadReportsView() {
  const cls = state.currentClassroom;
  if (!cls) return;

  // Nombre del salón en la vista
  const nameEl = document.getElementById('rpt-classroom-name');
  const subEl  = document.getElementById('rpt-classroom-sub');
  if (nameEl) nameEl.textContent = cls.name;
  if (subEl)  subEl.textContent  = [cls.subject, cls.grade].filter(Boolean).join(' · ');

  // Default: mes actual en el selector
  const monthSel = document.getElementById('rpt-month-sel');
  if (monthSel && !monthSel.value) {
    const now = new Date();
    monthSel.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }

  // Default: semana actual en el selector
  const weekInp = document.getElementById('rpt-week-input');
  if (weekInp && !weekInp.value) {
    const now = new Date();
    const day = now.getDay() || 7; // lunes = 1
    const mon = new Date(now); mon.setDate(now.getDate() - day + 1);
    weekInp.value = toLocalISO(mon);
  }

  // Renderizar lista de alumnos para reportes individuales
  renderReportsStudentList();
}

async function renderReportsStudentList() {
  const container = document.getElementById('rpt-students-list');
  if (!container || !state.currentClassroom) return;

  container.innerHTML = '<div style="padding:12px 0;color:var(--c-text-2);font-size:13px;">Cargando alumnos…</div>';

  try {
    const snap = await db.collection('classrooms').doc(state.currentClassroom.id)
      .collection('students').orderBy('name').get();
    const students = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (students.length === 0) {
      container.innerHTML = '<div style="padding:12px 0;color:var(--c-text-2);font-size:13px;">Sin alumnos en este salón</div>';
      return;
    }

    container.innerHTML = students.map((st, i) => {
      const bg = AVATAR_COLORS[i % AVATAR_COLORS.length];
      const ini = st.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
      return `
        <div class="rpt-student-row">
          <div class="aa-avatar sm" style="background:${bg}">${ini}</div>
          <span class="rpt-student-name">${st.name}</span>
          <button class="rpt-dl-btn" onclick="generateStudentReportPDF('${st.id}')">
            📄 PDF
          </button>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="padding:12px 0;color:var(--c-red);font-size:13px;">Error al cargar alumnos</div>';
  }
}
