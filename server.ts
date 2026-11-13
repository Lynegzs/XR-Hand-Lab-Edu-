import 'dotenv/config';
import express, { type RequestHandler } from 'express';
import fs from 'fs';
import { createServer as createHttpServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GoogleGenAI } from '@google/genai';
import {
  moderateContent,
  searchWikimediaCommons,
  getVerifiedTechnicalDiagram,
  generateAiImage,
  editAiImage,
} from './server-multimedia.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MODELS = new Set([
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
]);

const PAID_MODELS = new Set([
  'gemini-4-argon',
  'gemini-3-pro-image',
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
  'gemini-omni-1.1-flash',
  'lyria-3-clip-preview',
  'lyria-3-pro-preview',
]);

function resolveSafeModel(requested: unknown): string {
  const raw = String(requested || 'gemini-flash-latest').trim().replace(/^models\//, '');
  if (!raw) return 'gemini-flash-latest';
  if (PAID_MODELS.has(raw.toLowerCase())) return 'gemini-3.8-flash';
  if (/^gemini-(1\.5|2\.0)/i.test(raw)) return 'gemini-flash-latest';
  if (/image|nano-banana|argon|omni|lyria/i.test(raw)) return 'gemini-3.8-flash';
  if (ALLOWED_MODELS.has(raw) || /^gemini-3/i.test(raw)) return raw;
  return 'gemini-flash-latest';
}

function normalizeInlineMime(rawMime: string): string | null {
  const mime = rawMime.trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) return mime;
  if (mime === 'application/pdf') return 'application/pdf';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'audio/mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'audio/wav';
  if (mime === 'audio/ogg' || mime === 'audio/webm') return mime;
  return null;
}

let cachedGeminiKey = '';
let cachedGeminiClient: GoogleGenAI | null = null;

async function createGeminiClient(apiKey: string): Promise<GoogleGenAI> {
  if (cachedGeminiClient && cachedGeminiKey === apiKey) {
    return cachedGeminiClient;
  }
  const { GoogleGenAI: GoogleGenAICtor } = await import('@google/genai');
  cachedGeminiKey = apiKey;
  cachedGeminiClient = new GoogleGenAICtor({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  return cachedGeminiClient;
}

function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  // Ampliado para soportar múltiples archivos e imágenes adjuntos en una sola consulta (hasta 12 archivos)
  app.use(express.json({ limit: '45mb' }));

  // Servir binarios locales de MediaPipe si existen en disco; devolver 404 limpio en caso contrario (evita SPA fallback HTML)
  const localHandsDir = path.resolve(__dirname, 'node_modules/@mediapipe/hands');
  if (fs.existsSync(localHandsDir)) {
    app.use('/vendor/mediapipe/hands', express.static(localHandsDir, { maxAge: '7d', etag: true }));
  }
  const localTasksDir = path.resolve(__dirname, 'node_modules/@mediapipe/tasks-vision');
  if (fs.existsSync(localTasksDir)) {
    app.use('/vendor/mediapipe/tasks-vision', express.static(localTasksDir, { maxAge: '7d', etag: true }));
  }
  app.use(
    '/vendor/models',
    express.static(path.resolve(__dirname, 'public/vendor/models'), { maxAge: '30d' })
  );
  app.use('/vendor', (_req, res) => {
    res.status(404).end();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  app.get('/api/ai/health', (req, res) => {
    const customGroqKey = String(req.headers['x-groq-key'] || '').trim();
    const hasGroqKey = Boolean(customGroqKey || process.env.GROQ_API_KEY);
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);

    res.json({
      status: 'ok',
      timestamp: Date.now(),
      providers: {
        groq: {
          ok: hasGroqKey,
          label: 'Groq (Llama 3.3 70B / 120B)',
          configured: hasGroqKey,
          model: 'llama-3.3-70b-versatile',
          speed: 'ultra-rápido (~150-300 ms)'
        },
        gemini: {
          ok: hasGeminiKey,
          label: 'Google Gemini',
          configured: hasGeminiKey,
          model: 'gemini-flash-latest',
          speed: 'rápido multimodal'
        },
        pollinations: {
          ok: true,
          label: 'Pollinations AI',
          configured: true,
          free: true,
          speed: 'respaldo nube'
        },
        local: {
          ok: true,
          label: 'Base Técnica Local',
          configured: true,
          offline: true,
          speed: 'instantáneo (0 ms)'
        }
      }
    });
  });

  function buildContents(body: any) {
    const rawContents = Array.isArray(body?.contents) ? body.contents.slice(-18) : [];

    type RawPart = {
      text?: string;
      inlineData?: { mimeType?: string; data?: string };
    };

    const MAX_TOTAL_PAYLOAD_CHARS = 36_000_000;
    let totalPayloadChars = 0;

    const contents = rawContents
      .map((item: { role?: string; parts?: RawPart[] }) => {
        const role = item?.role === 'model' ? 'model' : 'user';
        const rawParts = Array.isArray(item?.parts) ? item.parts.slice(0, 32) : [];
        const parts: Array<
          | { text: string }
          | { inlineData: { mimeType: string; data: string } }
        > = [];

        for (const p of rawParts) {
          if (p?.inlineData?.data && p?.inlineData?.mimeType) {
            const safeMime = normalizeInlineMime(String(p.inlineData.mimeType));
            const cleanBase64 = String(p.inlineData.data)
              .replace(/^data:[^;]+;base64,/, '')
              .trim();
            if (
              safeMime &&
              cleanBase64.length > 16 &&
              cleanBase64.length <= 22_000_000 &&
              totalPayloadChars + cleanBase64.length <= MAX_TOTAL_PAYLOAD_CHARS
            ) {
              totalPayloadChars += cleanBase64.length;
              parts.push({
                inlineData: {
                  mimeType: safeMime,
                  data: cleanBase64,
                },
              });
            }
          }
          if (typeof p?.text === 'string' && p.text.trim().length > 0) {
            const sliced = p.text.slice(0, 24_000);
            if (totalPayloadChars + sliced.length <= MAX_TOTAL_PAYLOAD_CHARS) {
              totalPayloadChars += sliced.length;
              parts.push({ text: sliced });
            }
          }
        }

        return { role, parts };
      })
      .filter((c) => c.parts.length > 0);

    return contents;
  }

  app.post('/api/ai/gemini', async (req, res) => {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      res.status(503).json({
        error: { message: 'GEMINI_API_KEY no configurada en el servidor' },
      });
      return;
    }

    try {
      const model = resolveSafeModel(req.body?.model);
      const systemInstruction = String(req.body?.systemInstruction || '').slice(0, 4500);
      const contents = buildContents(req.body);

      if (!contents.length) {
        res.status(400).json({ error: { message: 'Pregunta o adjunto vacío' } });
        return;
      }

      const ai = await createGeminiClient(apiKey);
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          mediaResolution: 'MEDIA_RESOLUTION_LOW' as any,
        },
      });

      const text = (response.text || '').trim();
      if (!text) {
        res.status(502).json({ error: { message: 'Respuesta vacía del modelo' } });
        return;
      }

      res.json({ text, model });
    } catch (err: unknown) {
      const status =
        typeof (err as { status?: number })?.status === 'number'
          ? (err as { status: number }).status
          : 502;
      const rawMsg =
        err instanceof Error ? err.message : 'Error consultando Gemini';
      const shortMsg =
        status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(rawMsg)
          ? 'Cuota temporal agotada en Gemini (429)'
          : rawMsg.slice(0, 140);
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: { message: shortMsg },
      });
    }
  });

  app.post('/api/ai/gemini/stream', async (req, res) => {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) { res.status(503).json({ error: { message: 'GEMINI_API_KEY no configurada en el servidor' } }); return; }
    const contents = buildContents(req.body);
    if (!contents.length) { res.status(400).json({ error: { message: 'Pregunta o adjunto vacío' } }); return; }

    const model = resolveSafeModel(req.body?.model);
    const systemInstruction = String(req.body?.systemInstruction || '').slice(0, 4500);
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());

    try {
      const ai = await createGeminiClient(apiKey);
      const run = (withThinking: boolean) => ai.models.generateContentStream({
        model, contents,
        config: {
          systemInstruction, maxOutputTokens: 700, temperature: 0.4,
          abortSignal: ctl.signal,
          mediaResolution: 'MEDIA_RESOLUTION_LOW' as any,
          ...(withThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });
      let stream;
      try { stream = await run(true); }
      catch (e) {
        if (/thinking/i.test(String((e as Error)?.message))) stream = await run(false);
        else throw e;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      for await (const chunk of stream) {
        if (chunk.text) res.write(`data: ${JSON.stringify({ t: chunk.text })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true, model })}\n\n`);
      res.end();
    } catch (err: unknown) {
      const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 502;
      const raw = err instanceof Error ? err.message : 'Error consultando Gemini';
      const msg = status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw) ? 'Cuota temporal agotada en Gemini (429)' : raw.slice(0, 140);
      if (!res.headersSent) res.status(status >= 400 && status < 600 ? status : 502).json({ error: { message: msg } });
      else { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); }
    }
  });

  /* ==========================================================================
     INTEGRACIÓN ULTRA-RÁPIDA GROQ (Llama 3.3 70B & 120B)
     ========================================================================== */

  function resolveGroqKey(req: express.Request): string {
    const headerKey = String(req.headers['x-groq-key'] || '').trim();
    if (headerKey) return headerKey;
    const bodyKey = String((req.body as any)?.apiKey || '').trim();
    if (bodyKey) return bodyKey;
    return (process.env.GROQ_API_KEY || '').trim();
  }

  function buildGroqMessages(body: any): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];
    const sys = String(body?.systemInstruction || '').trim();
    if (sys) {
      messages.push({ role: 'system', content: sys.slice(0, 4500) });
    }

    if (Array.isArray(body?.messages) && body.messages.length > 0) {
      for (const m of body.messages.slice(-18)) {
        const role = m.role === 'assistant' || m.role === 'model' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
        const content = String(m.content || '').slice(0, 16000);
        if (content) messages.push({ role, content });
      }
      return messages;
    }

    if (Array.isArray(body?.contents)) {
      for (const c of body.contents.slice(-18)) {
        const role = c.role === 'model' ? 'assistant' : 'user';
        let text = '';
        if (Array.isArray(c.parts)) {
          for (const p of c.parts) {
            if (p.text) text += (text ? '\n' : '') + p.text;
          }
        }
        if (text) messages.push({ role, content: text.slice(0, 16000) });
      }
    }

    return messages;
  }

  // Validación de clave API de Groq
  app.post('/api/ai/groq/validate', async (req, res) => {
    const apiKey = resolveGroqKey(req);
    if (!apiKey) {
      res.status(400).json({ valid: false, message: 'Ingresa una clave API de Groq que comience con gsk_' });
      return;
    }

    try {
      const response = await fetch('https://api.groq.com/openai/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        let errData: any = null;
        try { errData = await response.json(); } catch {}
        const msg = errData?.error?.message || `Clave de Groq no autorizada (HTTP ${response.status})`;
        res.status(401).json({ valid: false, message: msg });
        return;
      }

      const data = (await response.json()) as any;
      const modelList = Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : [];
      const hasLlama33 = modelList.some((id: string) => /llama-3\.3/i.test(id));
      const hasAnyLlama = modelList.some((id: string) => /llama/i.test(id));
      const activeModel = hasLlama33 ? 'llama-3.3-70b-versatile' : (modelList.includes('openai/gpt-oss-120b') ? 'openai/gpt-oss-120b' : (modelList[0] || 'llama-3.3-70b-versatile'));

      res.json({
        valid: true,
        message: hasLlama33
          ? 'Clave de Groq válida: Motor Llama 3.3 (70B Versatile) habilitado'
          : `Clave de Groq válida: Motor ultra-rápido activado (${activeModel})`,
        hasLlama33,
        hasAnyLlama,
        activeModel,
        modelsCount: modelList.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al conectar con la API de Groq';
      res.status(502).json({ valid: false, message: msg });
    }
  });

  app.post('/api/ai/groq', async (req, res) => {
    const apiKey = resolveGroqKey(req);
    if (!apiKey) {
      res.status(503).json({ error: { message: 'Clave API de Groq no configurada' } });
      return;
    }

    const messages = buildGroqMessages(req.body);
    if (!messages.length) {
      res.status(400).json({ error: { message: 'Pregunta o historial vacío' } });
      return;
    }

    const requestedModel = String(req.body?.model || '').trim();
    let model = requestedModel && requestedModel !== 'auto' && requestedModel !== 'groq-llama'
      ? requestedModel
      : 'llama-3.3-70b-versatile';

    try {
      let response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
          reasoning_format: 'hidden',
          stream: false,
        }),
      });

      // Si el modelo Llama 3.3 no está en la clave actual, reintentar con gpt-oss-120b
      if (!response.ok && response.status === 404 && /llama-3\.3/i.test(model)) {
        model = 'openai/gpt-oss-120b';
        response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.4,
            max_tokens: 1024,
            reasoning_format: 'hidden',
            stream: false,
          }),
        });
      }

      if (!response.ok) {
        let errData: any = null;
        try { errData = await response.json(); } catch {}
        const msg = errData?.error?.message || `Error de Groq HTTP ${response.status}`;
        throw new Error(msg);
      }

      const data = (await response.json()) as any;
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('Respuesta vacía de Groq');
      res.json({ text, model });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Error consultando Groq';
      res.status(502).json({ error: { message: raw.slice(0, 180) } });
    }
  });

  app.post('/api/ai/groq/stream', async (req, res) => {
    const apiKey = resolveGroqKey(req);
    if (!apiKey) {
      res.status(503).json({ error: { message: 'Clave API de Groq no configurada' } });
      return;
    }

    const messages = buildGroqMessages(req.body);
    if (!messages.length) {
      res.status(400).json({ error: { message: 'Pregunta o historial vacío' } });
      return;
    }

    const requestedModel = String(req.body?.model || '').trim();
    let model = requestedModel && requestedModel !== 'auto' && requestedModel !== 'groq-llama'
      ? requestedModel
      : 'llama-3.3-70b-versatile';

    const ctl = new AbortController();
    res.on('close', () => ctl.abort());

    try {
      let upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
          reasoning_format: 'hidden',
          stream: true,
        }),
        signal: ctl.signal,
      });

      // Si el modelo Llama 3.3 no está en la clave actual, reintentar con gpt-oss-120b
      if (!upstream.ok && upstream.status === 404 && /llama-3\.3/i.test(model)) {
        model = 'openai/gpt-oss-120b';
        upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.4,
            max_tokens: 1024,
            reasoning_format: 'hidden',
            stream: true,
          }),
          signal: ctl.signal,
        });
      }

      if (!upstream.ok) {
        let errData: any = null;
        try { errData = await upstream.json(); } catch {}
        const msg = errData?.error?.message || `Error Groq HTTP ${upstream.status}`;
        res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({ error: { message: msg } });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const reader = upstream.body?.getReader();
      if (!reader) throw new Error('No readable stream from Groq');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            res.write(`data: ${JSON.stringify({ done: true, model })}\n\n`);
            continue;
          }
          try {
            const parsed = JSON.parse(payload);
            const deltaContent = parsed?.choices?.[0]?.delta?.content;
            if (deltaContent) {
              res.write(`data: ${JSON.stringify({ t: deltaContent })}\n\n`);
            }
          } catch {}
        }
      }

      res.write(`data: ${JSON.stringify({ done: true, model })}\n\n`);
      res.end();
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : 'Error consultando Groq';
      if (!res.headersSent) {
        res.status(502).json({ error: { message: raw.slice(0, 140) } });
      } else {
        res.write(`data: ${JSON.stringify({ error: raw.slice(0, 140) })}\n\n`);
        res.end();
      }
    }
  });

  /* ==========================================================================
     SISTEMA MULTIMEDIA AVANZADO: BÚSQUEDA, DIAGRAMAS, GENERACIÓN Y EDICIÓN
     ========================================================================== */

  const ipDailyUsage = new Map<string, { count: number; date: string }>();
  function checkRateLimit(ip: string): boolean {
    const maxDaily = Number(process.env.IMAGE_DAILY_LIMIT) || 80;
    const today = new Date().toISOString().slice(0, 10);
    const usage = ipDailyUsage.get(ip);
    if (!usage || usage.date !== today) {
      ipDailyUsage.set(ip, { count: 1, date: today });
      return true;
    }
    if (usage.count >= maxDaily) return false;
    usage.count++;
    return true;
  }

  // Estado y disponibilidad de proveedores multimedia
  app.get('/api/ai/image/status', (_req, res) => {
    res.json({
      status: 'ok',
      providers: {
        groq: Boolean(process.env.GROQ_API_KEY),
        wikimedia: true,
        svgLibrary: true,
        gemini: Boolean(process.env.GEMINI_API_KEY),
        cloudflare: Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN),
        pollinations: true,
      },
      defaultProvider: process.env.IMAGE_PROVIDER || 'auto',
      quality: process.env.IMAGE_QUALITY || 'balanced',
    });
  });

  // A. Búsqueda de fotografías reales en Wikimedia Commons
  app.post('/api/ai/image/search', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) {
        res.status(400).json({ error: { message: 'La consulta de búsqueda no puede estar vacía' } });
        return;
      }

      // Moderación de seguridad escolar
      const mod = moderateContent(query);
      if (!mod.safe) {
        res.status(400).json({ error: { message: mod.reason || 'Consulta bloqueada por políticas de protección escolar' } });
        return;
      }

      const limit = Math.min(Math.max(1, Number(req.body?.limit) || 6), 12);
      const items = await searchWikimediaCommons(query, limit);

      res.json({ query, items });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error buscando fotografías';
      res.status(502).json({ error: { message } });
    }
  });

  // C. Diagramas y esquemas técnicos (SVG verificado o generado)
  app.post('/api/ai/diagram/svg', async (req, res) => {
    try {
      const topic = String(req.body?.topic || '').trim();
      if (!topic) {
        res.status(400).json({ error: { message: 'El tema del diagrama no puede estar vacío' } });
        return;
      }

      // Moderación
      const mod = moderateContent(topic);
      if (!mod.safe) {
        res.status(400).json({ error: { message: mod.reason || 'Tema bloqueado por políticas de protección escolar' } });
        return;
      }

      // Comprobar biblioteca técnica verificada
      const verified = getVerifiedTechnicalDiagram(topic);
      if (verified) {
        res.json(verified);
        return;
      }

      // Si no existe un esquema verificado, no usar plantilla genérica; retornar 404
      res.status(404).json({ error: { message: 'NO_VERIFIED_DIAGRAM' } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error creando diagrama';
      res.status(500).json({ error: { message } });
    }
  });

  // B. Generación de imágenes mediante IA (Cloudflare / Gemini / Pollinations)
  app.post('/api/ai/image/generate', async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'local';
      if (!checkRateLimit(ip)) {
        res.status(429).json({ error: { message: 'Límite de solicitudes de imagen alcanzado por hoy. Continúa explorando los diagramas técnicos y modelos 3D.' } });
        return;
      }

      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) {
        res.status(400).json({ error: { message: 'La descripción de la imagen no puede estar vacía' } });
        return;
      }

      // Moderación
      const mod = moderateContent(prompt);
      if (!mod.safe) {
        res.status(400).json({ error: { message: mod.reason || 'Solicitud bloqueada por políticas de protección escolar.' } });
        return;
      }

      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      let geminiClient: GoogleGenAI | null = null;
      if (apiKey) {
        try { geminiClient = await createGeminiClient(apiKey); } catch {}
      }

      const result = await generateAiImage({
        prompt,
        style: req.body?.style || 'balanced',
        aspectRatio: req.body?.aspectRatio || '1:1',
        provider: req.body?.provider || 'auto',
        geminiClient,
      });

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al generar la imagen';
      res.status(502).json({ error: { message } });
    }
  });

  // D. Edición multimodal de imágenes (Gemini / Transformación)
  app.post('/api/ai/image/edit', async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'local';
      if (!checkRateLimit(ip)) {
        res.status(429).json({ error: { message: 'Límite de edición de imágenes alcanzado por hoy.' } });
        return;
      }

      const instruction = String(req.body?.instruction || '').trim();
      const imageBase64 = String(req.body?.imageBase64 || '').trim();
      const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();

      if (!instruction || !imageBase64) {
        res.status(400).json({ error: { message: 'Debes proporcionar una imagen adjunta y una instrucción de edición' } });
        return;
      }

      // Moderación
      const mod = moderateContent(instruction);
      if (!mod.safe) {
        res.status(400).json({ error: { message: mod.reason || 'Instrucción bloqueada por políticas de protección escolar.' } });
        return;
      }

      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      let geminiClient: GoogleGenAI | null = null;
      if (apiKey) {
        try { geminiClient = await createGeminiClient(apiKey); } catch {}
      }

      const result = await editAiImage({
        imageBase64,
        mimeType,
        instruction,
        geminiClient,
      });

      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al editar la imagen';
      res.status(502).json({ error: { message } });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    let resolvedViteMiddleware: RequestHandler | null = null;
    const viteReadyPromise = (async () => {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        configFile: false,
        optimizeDeps: {
          noDiscovery: true,
          include: [],
        },
        server: {
          middlewareMode: true,
          allowedHosts: true,
          hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
          watch: process.env.DISABLE_HMR === 'true' ? null : {},
        },
        appType: 'spa',
      });
      resolvedViteMiddleware = vite.middlewares as RequestHandler;
      return resolvedViteMiddleware;
    })();

    app.use(async (req, res, next) => {
      try {
        const mw = resolvedViteMiddleware || (await viteReadyPromise);
        mw(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath, { maxAge: '1h', etag: true }));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Enlazar el puerto 3000 de inmediato para evitar 502 / warmup timeout durante el arranque en frío
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
