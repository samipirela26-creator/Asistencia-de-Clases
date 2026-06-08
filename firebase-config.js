/* ============================================================
   firebase-config.js — Configuración de Firebase para AsistApp
   ============================================================ */

const firebaseConfig = {
  apiKey:            "AIzaSyDmYe363CoNKz92I_uGXPJc4LWVDhHpwak",
  authDomain:        "asistencia-f64f9.firebaseapp.com",
  projectId:         "asistencia-f64f9",
  storageBucket:     "asistencia-f64f9.firebasestorage.app",
  messagingSenderId: "472098792740",
  appId:             "1:472098792740:web:ce75a90cabe74a16a2ffb1"
};

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);

console.log('✓ Firebase inicializado — proyecto:', firebaseConfig.projectId);
