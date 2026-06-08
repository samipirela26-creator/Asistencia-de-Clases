/* ============================================================
   firebase-config.js — Configuración de Firebase para AsistApp
   ============================================================

   INSTRUCCIONES PASO A PASO:
   ─────────────────────────────────────────────────────────────

   1. Ve a https://console.firebase.google.com/
      (necesitas una cuenta de Google)

   2. Haz clic en "Agregar proyecto"
      → Ponle un nombre, ej: "asistapp-mi-colegio"
      → Desactiva Google Analytics (no es necesario)
      → Clic en "Crear proyecto"

   3. Dentro del proyecto, haz clic en el ícono Web: </>
      → Registra la app con cualquier nombre, ej: "AsistApp Web"
      → NO actives Firebase Hosting por ahora
      → Copia la configuración que aparece (el objeto firebaseConfig)

   4. Activa Firestore Database:
      → Menú lateral: Build → Firestore Database
      → Clic en "Crear base de datos"
      → Elige "Iniciar en modo de prueba" (gratis por 30 días)
      → Selecciona la ubicación más cercana (ej: us-central)
      → Clic en "Habilitar"

   5. ★ NUEVO — Activa Firebase Authentication:
      → Menú lateral: Build → Authentication
      → Clic en "Comenzar"
      → Pestaña "Sign-in method"
      → Activa "Correo electrónico/contraseña"
      → Guarda

   6. Reemplaza los valores de abajo con los de tu proyecto:

   ─────────────────────────────────────────────────────────────
   ★ REGLAS DE SEGURIDAD FIRESTORE (recomendado)

   En Firestore → Reglas, reemplaza todo con:

   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /classrooms/{classroomId} {
         allow read, write: if request.auth != null
           && request.auth.uid == resource.data.ownerId;
         allow create: if request.auth != null;
         match /{subcol}/{docId} {
           allow read, write: if request.auth != null;
         }
       }
       match /users/{userId} {
         allow read, write: if request.auth != null
           && request.auth.uid == userId;
       }
       match /settings/{docId} {
         allow read, write: if request.auth != null;
       }
       match /alerts/{classroomId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ─────────────────────────────────────────────────────────────
*/

const firebaseConfig = {
  apiKey:            "PEGA-AQUI-TU-API-KEY",
  authDomain:        "PEGA-AQUI-TU-AUTH-DOMAIN",
  projectId:         "PEGA-AQUI-TU-PROJECT-ID",
  storageBucket:     "PEGA-AQUI-TU-STORAGE-BUCKET",
  messagingSenderId: "PEGA-AQUI-TU-SENDER-ID",
  appId:             "PEGA-AQUI-TU-APP-ID"
};

// Inicializar Firebase
firebase.initializeApp(firebaseConfig);

console.log('✓ Firebase inicializado — proyecto:', firebaseConfig.projectId);
