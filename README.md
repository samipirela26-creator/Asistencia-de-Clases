# AsistApp 📋

PWA para llevar asistencia de clases en bachillerato. Funciona en el teléfono como una app instalada, guarda datos en la nube y funciona sin internet.

**URL:** https://samipirela26-creator.github.io/Asistencia-de-Clases

---

## Funcionalidades

### Salones y alumnos
- Crear, editar y eliminar salones
- Agregar alumnos por nombre
- Importar lista de alumnos desde texto o archivo

### Asistencia
- Tomar asistencia por fecha en modo lista
- **Modo Swipe** — deslizar tarjetas como Tinder: derecha = presente, izquierda = ausente
- Ver y editar asistencia de días anteriores

### Proyección en vivo
- Vista especial para proyectar en pantalla durante clase
- Muestra presentes, ausentes, total y porcentaje en tiempo real

### Alertas inteligentes
- Alerta cuando un alumno acumula demasiadas faltas
- Alerta cuando un alumno falta siempre el mismo día de la semana
- Alerta cuando un salón entero tiene baja asistencia
- Badge rojo en la navegación con contador de alertas activas

### Reportes
- Exportar reporte en PDF
- Exportar reporte en Excel (.xlsx)

### Autenticación
- Registro e inicio de sesión con correo y contraseña
- Cada maestro ve solo sus propios salones
- Recuperación de contraseña por correo
- Perfil editable (nombre, correo, contraseña)

### PWA
- Instalable en iPhone (Safari → Compartir → Añadir a pantalla de inicio)
- Instalable en Android (Chrome → Instalar app)
- Funciona offline con Service Worker
- Sincronización automática al recuperar conexión

---

## Tecnologías

| Tecnología | Uso |
|---|---|
| HTML / CSS / JS vanilla | Frontend |
| Firebase Firestore | Base de datos en la nube |
| Firebase Authentication | Cuentas de usuario |
| Service Worker | Caché offline y PWA |
| GitHub Pages | Hosting gratuito con HTTPS |
| jsPDF + AutoTable | Exportar PDF |
| SheetJS (xlsx) | Exportar Excel |

---

## Archivos principales

```
├── index.html          # Estructura de todas las vistas
├── app.js              # Lógica principal (~3000 líneas)
├── styles.css          # Estilos (~2000 líneas)
├── reports.js          # Generación de PDF y Excel
├── firebase-config.js  # Credenciales de Firebase
├── service-worker.js   # Caché offline (versión actual: v8)
├── manifest.json       # Configuración PWA
└── offline.html        # Página sin conexión
```

---

## Firebase

**Proyecto:** asistencia-f64f9

Servicios usados:
- **Firestore** — colecciones: `classrooms`, `sessions`, `alerts`
- **Authentication** — proveedor: correo/contraseña

Reglas de seguridad Firestore:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

---

## Estructura de datos en Firestore

```
classrooms/
  {id}
    name: string
    ownerId: string        ← UID del maestro dueño
    students: string[]

sessions/
  {id}
    classroomId: string
    date: string (YYYY-MM-DD)
    attendance: { [nombre]: boolean }

alerts/
  {id}
    classroomId: string
    studentName: string
    type: 'threshold' | 'pattern' | 'classroom'
    message: string
    dismissed: boolean
```

---

## Desarrollo local

```bash
git clone https://github.com/samipirela26-creator/Asistencia-de-Clases.git
cd Asistencia-de-Clases
# Abrir index.html en el navegador
# (requiere servidor local para Service Worker)
python3 -m http.server 8080
```

## Deploy

```bash
git add -A
git commit -m "descripción del cambio"
git push
# GitHub Pages publica automáticamente en ~2 minutos
```
