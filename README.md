# XR Hand Lab Edu

Laboratorio educativo de **Realidad Aumentada y 3D interactivo controlado con gestos de las manos**, enfocado en el área de **Tecnología e Informática**: *el computador por dentro y por fuera* (grados 1.° a 11.°).

Los estudiantes pueden explorar, desarmar, ensamblar y diagnosticar un computador virtual usando la cámara web (visión artificial con MediaPipe), o con ratón y pantalla táctil si no cuentan con cámara.

---

## Características

- **Control por gestos** con MediaPipe Hands / Hand Landmarker (1–2 manos, 21 puntos): pellizco, arrastre, zoom con dos manos, rotación con la palma, señalar, menú radial, deslizar y pulgar arriba.
- **Respaldo universal** de ratón, táctil, teclado y botones en pantalla (ningún estudiante queda excluido).
- **Estaciones 3D por subtema**: arquitectura interna, procesamiento y memorias, almacenamiento y energía, periféricos E/S, puertos y conectividad, portátil vs. escritorio.
- **Modos de laboratorio**: vista explosionada y capas, reto *Armar el PC* (con zócalos magnéticos), *Diagnóstico de fallas* y comparadores (RAM vs. disco, CPU vs. GPU, HDD vs. SSD).
- **Cargador de modelos propios** `.GLB` / `.GLTF` (locales o por URL HTTPS).
- **Asistente IA de Tecnología** con respaldo en cascada: Groq → Gemini → Pollinations → base técnica local (funciona sin internet).
- **Multimedia educativa**: búsqueda en Wikimedia Commons, diagramas SVG verificados y generación/edición de imágenes con IA (con límite diario por IP).
- **Moderación de contenido** y sanitización de SVG pensadas para uso escolar.
- **Historial de chat persistente** (`localStorage`) y exportación a **PDF** (jsPDF) y **JSON**.
- **Accesibilidad**: subtítulos de gestos y narración, voz `es-CO`, alto contraste, `prefers-reduced-motion`, objetivos táctiles ≥ 44 px.
- **Privacidad**: el video de la cámara y los datos de gestos se procesan localmente y **nunca** se envían a ningún servicio.

---

## Gestos soportados

| Gesto | Acción |
|---|---|
| Pellizco / arrastre | Selecciona y mueve piezas; extraer y encajar en zócalos |
| Doble pellizco (separar / juntar) | Escala y acerca / aleja el modelo |
| Giro de palma abierta | Rota la estación 360° |
| Índice + medio (señalar) | Abre la ficha técnica de la pieza |
| Palma abierta 1,5 s | Abre el menú radial |
| Deslizar mano lateral | Siguiente / anterior estación |
| Pulgar arriba | Confirma selecciones |

---

## Tecnologías

- **Frontend:** `index.html` autocontenido (HTML + CSS + JS), Three.js, `<model-viewer>`, Web Audio API, Web Speech API
- **Visión artificial:** `@mediapipe/hands` y `@mediapipe/tasks-vision` (modelo `hand_landmarker.task`)
- **Backend:** Node.js + Express (`server.ts`, ejecutado con `tsx`)
- **IA:** `@google/genai` (Gemini), Groq (Llama 3.3), Pollinations, Cloudflare Workers AI (opcional)
- **PDF:** `jspdf`
- **Build / despliegue:** Vite y Netlify (funciones serverless)

---

## Requisitos

- **Node.js 20+** (también funciona con Bun, el repo incluye `bun.lock`)
- Navegador moderno con soporte WebGL y `getUserMedia` (Chrome, Edge, Firefox, Safari)
- Cámara web (opcional)
- Claves de API (opcionales, ver [Variables de entorno](#variables-de-entorno))

> La cámara requiere un contexto seguro: `https://` o `http://localhost`.

---

## Instalación y uso local

```bash
# 1. Instalar dependencias (el postinstall descarga el modelo hand_landmarker.task)
npm install

# 2. Crear el archivo de entorno
cp .env.example .env
# editar .env y agregar tus claves

# 3. Iniciar el servidor de desarrollo
npm run dev
```

La aplicación queda disponible en **http://localhost:3000** (puedes cambiar el puerto con la variable `PORT`).

### Scripts disponibles

| Script | Descripción |
|---|---|
| `npm run dev` | Inicia el servidor Express con `tsx` |
| `npm start` | Igual que `dev` (modo producción) |
| `npm run build` | Genera el build estático con Vite en `dist/` |
| `npm run lint` | Verifica la sintaxis de `scripts/download-models.mjs` |
| `postinstall` | Descarga automáticamente el modelo de manos si no existe |

> Si la descarga del modelo falla, la app usa un **fallback remoto** (CDN) automáticamente.

---

## Variables de entorno

Copia `.env.example` a `.env`. **Todas son opcionales**: sin claves, el asistente usa la base técnica local.

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `GROQ_API_KEY` | Clave de Groq (Llama 3.3, respuestas ultrarrápidas) | — |
| `GEMINI_API_KEY` | Clave de Google Gemini ([AI Studio](https://aistudio.google.com/apikey)) | — |
| `IMAGE_PROVIDER` | Proveedor de imágenes: `auto` (Cloudflare → Gemini → Pollinations) | `auto` |
| `IMAGE_QUALITY` | Calidad de imagen: `fast`, `balanced` o `high` | `balanced` |
| `IMAGE_DAILY_LIMIT` | Máximo de imágenes por IP al día (protección escolar) | `80` |
| `CLOUDFLARE_ACCOUNT_ID` | ID de cuenta de Cloudflare Workers AI | — |
| `CLOUDFLARE_API_TOKEN` | Token de Cloudflare Workers AI | — |
| `PORT` | Puerto del servidor | `3000` |

> ⚠️ **Nunca subas tu archivo `.env` al repositorio.** Agrégalo a `.gitignore`.

---

## API

Todos los endpoints viven bajo `/api`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servidor |
| GET | `/api/ai/health` | Estado de los proveedores de IA |
| POST | `/api/ai/gemini` | Consulta a Gemini |
| POST | `/api/ai/gemini/stream` | Consulta a Gemini con streaming |
| POST | `/api/ai/groq` | Consulta a Groq |
| POST | `/api/ai/groq/stream` | Consulta a Groq con streaming |
| POST | `/api/ai/groq/validate` | Valida una clave de Groq (cabecera `x-groq-key`) |
| GET | `/api/ai/image/status` | Disponibilidad de proveedores de imagen |
| POST | `/api/ai/image/search` | Búsqueda de fotos en Wikimedia Commons |
| POST | `/api/ai/diagram/svg` | Diagrama técnico SVG (verificado o generado) |
| POST | `/api/ai/image/generate` | Generación de imagen con IA |
| POST | `/api/ai/image/edit` | Edición de imagen con IA |

Detalles a tener en cuenta:

- El cuerpo JSON admite hasta **45 MB** (varios adjuntos por consulta).
- Se aceptan adjuntos `image/png|jpeg|webp|gif`, `application/pdf` y audio `mp3|wav|ogg|webm`.
- Solo se permiten modelos Gemini gratuitos; los modelos de pago se redirigen automáticamente a uno permitido.
- El contenido pasa por moderación y los SVG se sanitizan antes de mostrarse.

---

## Estructura del proyecto

```text
.
├── index.html                 # Aplicación completa (UI, escena 3D, gestos, chat IA)
├── server.ts                  # Servidor Express + endpoints de IA
├── server-multimedia.ts       # Moderación, Wikimedia, diagramas SVG, generación de imágenes
├── netlify/
│   └── functions/api.ts       # Versión serverless de la API para Netlify
├── netlify.toml               # Configuración de despliegue en Netlify
├── vite.config.js             # Configuración de Vite
├── scripts/
│   └── download-models.mjs    # Descarga hand_landmarker.task
├── public/
│   ├── vendor/
│   │   ├── jspdf.umd.min.js
│   │   └── models/hand_landmarker.task
│   └── assets/aistudio/       # Imágenes y documentos de apoyo
├── .env.example               # Plantilla de variables de entorno
├── package.json
└── bun.lock
```

---

## Despliegue

### Netlify

El proyecto incluye `netlify.toml`:

- **Build:** `npm run build` → publica `dist/`
- **Node:** 20
- Las rutas `/api/*` se redirigen a `/.netlify/functions/api/`
- Cualquier otra ruta se sirve como SPA (`/index.html`)
- El modelo `hand_landmarker.task` se cachea por 30 días

Configura las variables de entorno (`GROQ_API_KEY`, `GEMINI_API_KEY`, etc.) en **Site settings → Environment variables**.

> La función de Netlify (`netlify/functions/api.ts`) cubre salud y Groq. Los endpoints de Gemini e imágenes corren en el servidor Express, así que para tenerlos completos usa un hosting Node (Render, Railway, VPS, etc.).

### Servidor Node

```bash
npm install
npm run build
npm start
```

---

## Pedagogía

Cada estación incluye una misión de indagación *Observar → Señalar → Explicar → Transferir*, retos cronometrados, fichas imprimibles, puntos de interés 3D con atribución de licencias y un copiloto pedagógico offline para sesiones de 20, 35, 50 y 90 minutos.

---

## Solución de problemas

| Problema | Posible solución |
|---|---|
| La cámara no se activa | Usa `https://` o `localhost` y concede el permiso en el navegador |
| Los gestos no se detectan | Mejora la iluminación y mantén la mano completa en cuadro; usa ratón/táctil como alternativa |
| No descarga el modelo en `postinstall` | Ejecuta `node scripts/download-models.mjs` o usa el fallback remoto |
| El asistente responde solo con la base local | Verifica `GEMINI_API_KEY` / `GROQ_API_KEY` en `.env` y consulta `/api/ai/health` |
| Error de cuota de imágenes | Se alcanzó `IMAGE_DAILY_LIMIT`; espera al día siguiente o aumenta el valor |

---

## Licencias y créditos

- [MediaPipe](https://developers.google.com/mediapipe) — Google (Apache 2.0)
- [Three.js](https://threejs.org/) y [`<model-viewer>`](https://modelviewer.dev/)
- [jsPDF](https://github.com/parallax/jsPDF)
- Imágenes de [Wikimedia Commons](https://commons.wikimedia.org/) con atribución según su licencia

> Define aquí la licencia de tu proyecto (por ejemplo MIT) y los datos de autoría.