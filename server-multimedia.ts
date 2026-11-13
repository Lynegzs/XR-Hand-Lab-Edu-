import type { GoogleGenAI } from '@google/genai';

export interface ModerationResult {
  safe: boolean;
  reason?: string;
  category?: string;
}

export interface WikimediaImage {
  id: string;
  title: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  size: number;
  mime: string;
  artist: string;
  license: string;
  licenseUrl: string;
  descriptionUrl: string;
  description: string;
}

export interface GeneratedImageResult {
  dataUrl: string;
  prompt: string;
  provider: string;
  width: number;
  height: number;
  revisedPrompt?: string;
}

export interface DiagramResult {
  svg: string;
  topic: string;
  title: string;
  isVerified: boolean;
  components?: string[];
  description?: string;
}

/* ==========================================================================
   1. SISTEMA DE MODERACIÓN Y PROTECCIÓN ESCOLAR (Sección 12)
   ========================================================================== */

const BLOCKED_PATTERNS = [
  // Pornografía y sexual explícito
  /\b(porno|pornograf[íi]a|porn|xxx|hentai|nsfw|desnudo\s+expl[íi]cito|sexo\s+expl[íi]cito|er[oó]tico|genitales|erecci[oó]n|masturbaci[oó]n|coito)\b/i,
  // Sexualización de menores
  /\b(pedofil[íi]a|menor\s+desnudo|child\s*porn|csam|lolicon|sexualizaci[oó]n\s+infantil)\b/i,
  // Violencia extrema y gore
  /\b(gore|decapitaci[oó]n|mutilaci[oó]n|desmembramiento|tripas|masacre\s+sangrienta|tortura\s+humana|asesinato\s+expl[íi]cito)\b/i,
  // Autolesiones
  /\b(suicidio\s+expl[íi]cito|cortarse\s+las\s+venas|ahorcamiento|autolesi[oó]n\s+gr[aá]fica)\b/i,
  // Daños o armas peligrosas
  /\b(bomba\s+casera|fabricar\s+explosivo|c[oó]ctel\s+molotov|veneno\s+letal|armas\s+de\s+fuego\s+artesanales)\b/i,
];

// Términos científicos, biológicos y tecnológicos permitidos en educación escolar
const EDUCATIONAL_PATTERNS = [
  /anatom[íi]a\s+(del\s+ojo|del\s+o[íi]do|del\s+coraz[oó]n|del\s+cerebro|humana|escolar|del\s+cuerpo)/i,
  /c[eé]lula|mitocondria|aparato\s+circulatorio|sistema\s+nervioso|esqueleto|hueso|m[úu]sculo/i,
  /microprocesador|placa\s+madre|circuito|resistencia|diodo|transistor|condensador|fuente/i,
  /corte\s+transversal|disecci[oó]n\s+bot[aá]nica|biolog[íi]a|disipador|hardware|arquitectura/i,
];

export function moderateContent(text: string): ModerationResult {
  const clean = String(text || '').trim();
  if (!clean) return { safe: true };

  // Comprobar si coincide con patrones permitidos educativos
  const isEducational = EDUCATIONAL_PATTERNS.some((p) => p.test(clean));

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(clean)) {
      if (isEducational) {
        // Excepción educativa válida para diagramas de anatomía o ciencias
        const isDangerous = /\b(child\s*porn|csam|pedofil|suicidio|fabricar\s+explosivo)\b/i.test(clean);
        if (isDangerous) {
          return {
            safe: false,
            category: 'seguridad_extrema',
            reason: 'Esta solicitud no puede procesarse porque infringe las políticas de protección escolar de XR Hand Lab Edu.',
          };
        }
        // Permitir contexto educativo legítimo
        return { safe: true };
      }

      return {
        safe: false,
        category: 'contenido_no_escolar',
        reason: 'Esta solicitud contiene términos restringidos para el entorno escolar. En XR Hand Lab Edu nos enfocamos en tecnología, hardware, informática y ciencias.',
      };
    }
  }

  return { safe: true };
}

/* ==========================================================================
   2. SANEAMIENTO DE SVG TÉCNICOS (Sección 7)
   ========================================================================== */

export function sanitizeSvg(rawSvg: string): string {
  if (!rawSvg) return '';
  let svg = String(rawSvg).trim();

  // Eliminar etiquetas y atributos peligrosos
  svg = svg.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  svg = svg.replace(/<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi, '');
  svg = svg.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  svg = svg.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  svg = svg.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
  svg = svg.replace(/on\w+\s*=\s*(["'][^"']*["']|[^\s>]+)/gi, '');
  svg = svg.replace(/javascript\s*:/gi, 'blocked:');
  svg = svg.replace(/data\s*:\s*text\/html/gi, 'blocked:');

  // Asegurar que comience con <svg y termine con </svg>
  const svgStart = svg.indexOf('<svg');
  const svgEnd = svg.lastIndexOf('</svg>');
  if (svgStart >= 0 && svgEnd > svgStart) {
    svg = svg.slice(svgStart, svgEnd + 6);
  }

  // Asegurar xmlns y viewBox para responsividad
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  return svg;
}

/* ==========================================================================
   3. BÚSQUEDA DE FOTOGRAFÍAS REALES EN WIKIMEDIA COMMONS (Sección 2.A)
   ========================================================================== */

const wikimediaCache = new Map<string, { items: WikimediaImage[]; timestamp: number }>();
const CACHE_TTL_WIKIMEDIA = 24 * 60 * 60 * 1000; // 24 horas

function sanitizeHtmlSnippet(html: string): string {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

const JUNK_MEDIA_PATTERN = /\b(alumni|birthday|cumplea[ñn]os|party|fiesta|reunion|reuni[oó]n|wedding|boda|portrait|people\s+at|group\s+of|dinner|cena|ceremony|celebration|celebraci[oó]n|politician|protest|manifestaci[oó]n|memorial|monument|statue|estatua|tomb|cemetery|cementerio|jug|bottle|botella|cup|glass|dish|food|comida|animal|dog|perro|cat|gato|band\s+members)\b/i;

function disambiguateWikimediaQuery(rawQuery: string): { searchTerms: string; requiredKeyword?: RegExp } {
  const clean = rawQuery
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(foto|fotografia|imagen|imagenes|muestra)\s+(real\s+)?(de|del|de\s+un|de\s+una)\s+/i, '')
    .trim();

  // Mapeos a términos precisos para evitar falsos positivos
  if (/^(un\s+|el\s+)?pc\b|^computador(a)?\b|^ordenador\b|^computador\s+de\s+escritorio\b/i.test(clean)) {
    return { searchTerms: 'desktop PC computer', requiredKeyword: /pc|computer|komputer|desktop|ibm|msi/i };
  }
  if (/\b(gabinete|chasis|torre\s+pc|caja\s+pc)\b/i.test(clean)) {
    return { searchTerms: 'desktop computer case', requiredKeyword: /case|tower|pc|chassis/i };
  }
  if (/\b(cpu|procesador|microprocesador)\b/i.test(clean)) {
    return { searchTerms: 'microprocessor CPU chip', requiredKeyword: /cpu|processor|procesador|intel|amd|chip/i };
  }
  if (/\b(gpu|tarjeta\s+grafica|tarjeta\s+de\s+video)\b/i.test(clean)) {
    return { searchTerms: 'graphics card GPU', requiredKeyword: /graphics|card|gpu|radeon|geforce|nvidia/i };
  }
  if (/\b(ram|memoria\s+ram)\b/i.test(clean)) {
    return { searchTerms: 'RAM memory module', requiredKeyword: /ram|memory|ddr|dimm/i };
  }
  if (/\b(placa\s+madre|tarjeta\s+madre|placa\s+base|motherboard)\b/i.test(clean)) {
    return { searchTerms: 'computer motherboard', requiredKeyword: /motherboard|mainboard|plyta/i };
  }
  if (/\b(fuente\s+de\s+poder|fuente\s+de\s+alimentacion|psu)\b/i.test(clean)) {
    return { searchTerms: 'computer ATX power supply', requiredKeyword: /power|supply|atx|psu/i };
  }
  if (/\b(disco\s+duro|hdd)\b/i.test(clean)) {
    return { searchTerms: 'hard disk drive HDD', requiredKeyword: /hard\s*disk|hdd|drive/i };
  }
  if (/\b(ssd|disco\s+solido)\b/i.test(clean)) {
    return { searchTerms: 'solid state drive SSD', requiredKeyword: /ssd|solid\s*state/i };
  }
  if (/\b(diodo)\b/i.test(clean)) {
    return { searchTerms: 'semiconductor diode component', requiredKeyword: /diode|diodo/i };
  }
  if (/\b(resistencia|resistor)\b/i.test(clean)) {
    return { searchTerms: 'electronic resistor component', requiredKeyword: /resistor|resistencia/i };
  }
  if (/\b(condensador|capacitor)\b/i.test(clean)) {
    return { searchTerms: 'electrolytic capacitor component', requiredKeyword: /capacitor|condensador/i };
  }
  if (/\b(transistor)\b/i.test(clean)) {
    return { searchTerms: 'transistor electronic component', requiredKeyword: /transistor/i };
  }
  if (/\b(led)\b/i.test(clean)) {
    return { searchTerms: 'light emitting diode LED', requiredKeyword: /led|diode/i };
  }
  if (/\b(disipador|cooler|ventilador\s+cpu)\b/i.test(clean)) {
    return { searchTerms: 'computer CPU heatsink cooler', requiredKeyword: /heatsink|cooler|fan/i };
  }

  return { searchTerms: clean };
}

export async function searchWikimediaCommons(query: string, limit = 6): Promise<WikimediaImage[]> {
  const normKey = query.toLowerCase().trim();
  const cached = wikimediaCache.get(normKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_WIKIMEDIA) {
    return cached.items;
  }

  const { searchTerms, requiredKeyword } = disambiguateWikimediaQuery(normKey);

  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
    searchTerms
  )}&gsrnamespace=6&gsrlimit=${Math.min(limit * 3, 20)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280&format=json&origin=*`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'XRHandLabEdu/1.0 (Educational STEM lab; contact: info@xrhandlab.edu)',
      },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Wikimedia API error: ${res.status}`);
    const data = (await res.json()) as any;
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];

    const results: WikimediaImage[] = [];

    for (const page of pages as any[]) {
      const info = page?.imageinfo?.[0];
      if (!info || !info.url) continue;

      const mime = String(info.mime || '').toLowerCase();
      // Filtrar formatos visuales estándar
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) continue;

      // Filtrar imágenes de resolución adecuada (mínimo 300px)
      const width = Number(info.width) || 0;
      const height = Number(info.height) || 0;
      if (width < 320 || height < 240) continue;

      const meta = info.extmetadata || {};
      const artist = sanitizeHtmlSnippet(meta.Artist?.value || meta.Credit?.value || 'Wikimedia Commons');
      const license = sanitizeHtmlSnippet(meta.LicenseShortName?.value || meta.License?.value || 'CC / Dominio Público');
      const licenseUrl = meta.LicenseUrl?.value || 'https://creativecommons.org/';
      const description = sanitizeHtmlSnippet(
        meta.ImageDescription?.value || meta.ObjectName?.value || page.title || ''
      ).slice(0, 300);

      const cleanTitle = String(page.title || '')
        .replace(/^Archivo:|^File:/i, '')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/_/g, ' ')
        .slice(0, 100);

      // Descartar fotos no educativas o irrelevantes (cumpleaños, fiestas, reuniones, botellas, personas)
      if (JUNK_MEDIA_PATTERN.test(cleanTitle) || JUNK_MEDIA_PATTERN.test(description) || JUNK_MEDIA_PATTERN.test(artist)) {
        continue;
      }

      // Si hay palabra clave técnica requerida, verificar que el título o la descripción la contenga
      if (requiredKeyword && !requiredKeyword.test(cleanTitle) && !requiredKeyword.test(description)) {
        continue;
      }

      results.push({
        id: `wiki-${page.pageid || Math.random().toString(36).slice(2, 9)}`,
        title: cleanTitle || 'Fotografía real',
        url: info.url,
        thumbUrl: info.thumburl || info.url,
        width,
        height,
        size: Number(info.size) || 0,
        mime,
        artist: artist.slice(0, 120),
        license: license.slice(0, 60),
        licenseUrl,
        descriptionUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        description,
      });

      if (results.length >= limit) break;
    }

    wikimediaCache.set(normKey, { items: results, timestamp: Date.now() });
    return results;
  } finally {
    clearTimeout(timeout);
  }
}

/* ==========================================================================
   4. BIBLIOTECA VERIFICADA DE DIAGRAMAS SVG EDUCATIVOS (Sección 2.C)
   ========================================================================== */

export function getVerifiedTechnicalDiagram(topic: string): DiagramResult | null {
  const t = topic.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // 1. Resistencia eléctrica con código de colores y símbolo
  if (/resistencia|codigo\s+de\s+colores|resistor/.test(t)) {
    return {
      topic: 'resistencia',
      title: 'Resistencia Eléctrica y Código de Colores',
      isVerified: true,
      description: 'Muestra el símbolo esquemático, la estructura física de 4 bandas y la fórmula de la Ley de Ohm.',
      components: ['Cuerpo cerámico', 'Bandas de color (1kΩ ±5%)', 'Símbolo ANSI/IEC', 'Terminales metálicos'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <defs>
    <linearGradient id="resBody" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#D9B78C"/>
      <stop offset="50%" stop-color="#F2D8B3"/>
      <stop offset="100%" stop-color="#D9B78C"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="800" height="480" fill="#041527" rx="12"/>
  <rect x="20" y="20" width="760" height="440" fill="none" stroke="#00B7FF" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.4" rx="8"/>

  <!-- Encabezado -->
  <text x="40" y="55" fill="#00E5FF" font-size="20" font-weight="bold" filter="url(#glow)">RESISTENCIA ELÉCTRICA (RESISTOR)</text>
  <text x="40" y="80" fill="#88AABF" font-size="13">Componente pasivo que limita el paso de corriente eléctrica y divide tensiones</text>

  <!-- Terminales -->
  <line x1="60" y1="200" x2="220" y2="200" stroke="#B0C4DE" stroke-width="8" stroke-linecap="round"/>
  <line x1="580" y1="200" x2="740" y2="200" stroke="#B0C4DE" stroke-width="8" stroke-linecap="round"/>

  <!-- Cuerpo de la resistencia -->
  <rect x="220" y="140" width="360" height="120" rx="40" fill="url(#resBody)" stroke="#997A52" stroke-width="3"/>

  <!-- Bandas de color (1k Ohm: Marrón=1, Negro=0, Rojo=x100, Dorado=±5%) -->
  <!-- 1. Marrón -->
  <rect x="280" y="140" width="22" height="120" fill="#7A3E1D"/>
  <text x="291" y="290" fill="#D9B78C" font-size="12" text-anchor="middle">1.ª Banda: 1</text>
  <text x="291" y="306" fill="#7A3E1D" font-size="11" font-weight="bold" text-anchor="middle">(Marrón)</text>

  <!-- 2. Negro -->
  <rect x="340" y="140" width="22" height="120" fill="#1A1A1A"/>
  <text x="351" y="290" fill="#D9B78C" font-size="12" text-anchor="middle">2.ª Banda: 0</text>
  <text x="351" y="306" fill="#A0A0A0" font-size="11" font-weight="bold" text-anchor="middle">(Negro)</text>

  <!-- 3. Rojo (Multiplicador) -->
  <rect x="400" y="140" width="22" height="120" fill="#D32F2F"/>
  <text x="411" y="290" fill="#D9B78C" font-size="12" text-anchor="middle">Mult: ×100</text>
  <text x="411" y="306" fill="#FF5252" font-size="11" font-weight="bold" text-anchor="middle">(Rojo)</text>

  <!-- 4. Dorado (Tolerancia) -->
  <rect x="500" y="140" width="22" height="120" fill="#D4AF37"/>
  <text x="511" y="290" fill="#D9B78C" font-size="12" text-anchor="middle">Tol: ±5%</text>
  <text x="511" y="306" fill="#FFD700" font-size="11" font-weight="bold" text-anchor="middle">(Dorado)</text>

  <!-- Valor resultante -->
  <rect x="250" y="330" width="300" height="46" rx="8" fill="#08233C" stroke="#00E5FF" stroke-width="1.5"/>
  <text x="400" y="360" fill="#00FFC8" font-size="18" font-weight="bold" text-anchor="middle">Valor = 10 × 100 = 1.000 Ω (1 kΩ) ± 5%</text>

  <!-- Símbolos esquemáticos -->
  <g transform="translate(40, 395)">
    <text x="0" y="18" fill="#88AABF" font-size="12" font-weight="bold">SÍMBOLO ANSI:</text>
    <path d="M 120 12 L 140 12 L 148 0 L 164 24 L 180 0 L 196 24 L 212 0 L 220 12 L 240 12" fill="none" stroke="#00E5FF" stroke-width="2.5"/>
  </g>

  <g transform="translate(440, 395)">
    <text x="0" y="18" fill="#88AABF" font-size="12" font-weight="bold">SÍMBOLO IEC / EUROPEO:</text>
    <line x1="170" y1="12" x2="190" y2="12" stroke="#00E5FF" stroke-width="2.5"/>
    <rect x="190" y="2" width="60" height="20" fill="none" stroke="#00E5FF" stroke-width="2"/>
    <line x1="250" y1="12" x2="270" y2="12" stroke="#00E5FF" stroke-width="2.5"/>
  </g>
</svg>`),
    };
  }

  // 2. LED y circuito de protección
  if (/\bled\b|diodo\s+emisor|diodo\s+led/.test(t)) {
    return {
      topic: 'led',
      title: 'Diodo Emisor de Luz (LED) y Polarización',
      isVerified: true,
      description: 'Identificación de Ánodo (+), Cátodo (-), símbolo esquemático y circuito con resistencia limitadora.',
      components: ['Ánodo (pata larga, +)', 'Cátodo (pata corta, bisel plano, -)', 'Lente epóxica', 'Resistencia limitadora (330Ω)'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <defs>
    <radialGradient id="ledGlow" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="#00FFAA" stop-opacity="0.9"/>
      <stop offset="70%" stop-color="#009966" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#003322" stop-opacity="0.9"/>
    </radialGradient>
  </defs>

  <rect width="800" height="480" fill="#041527" rx="12"/>
  <text x="40" y="55" fill="#00FFAA" font-size="20" font-weight="bold">DIODO EMISOR DE LUZ (LED)</text>
  <text x="40" y="80" fill="#88AABF" font-size="13">Semiconductor que emite fotones bajo polarización directa (requiere resistencia de protección)</text>

  <!-- Diagrama físico LED -->
  <g transform="translate(140, 110)">
    <!-- Cúpula LED -->
    <path d="M 30 110 L 30 70 A 50 50 0 0 1 130 70 L 130 110 Z" fill="url(#ledGlow)" stroke="#00FFAA" stroke-width="3"/>
    <rect x="25" y="110" width="110" height="15" rx="3" fill="#009966" stroke="#00FFAA" stroke-width="2"/>
    <!-- Bisel plano en cátodo -->
    <line x1="135" y1="108" x2="135" y2="127" stroke="#FF5555" stroke-width="4"/>
    <text x="145" y="122" fill="#FF5555" font-size="11" font-weight="bold">Lado plano (-)</text>

    <!-- Terminales / Patillas -->
    <line x1="55" y1="125" x2="55" y2="250" stroke="#B0C4DE" stroke-width="6"/> <!-- Ánodo más largo -->
    <line x1="105" y1="125" x2="105" y2="210" stroke="#B0C4DE" stroke-width="6"/> <!-- Cátodo más corto -->

    <!-- Etiquetas patillas -->
    <text x="55" y="275" fill="#00FFAA" font-size="14" font-weight="bold" text-anchor="middle">Ánodo (+)</text>
    <text x="55" y="293" fill="#88AABF" font-size="11" text-anchor="middle">Pata más larga</text>

    <text x="105" y="235" fill="#FF6B6B" font-size="14" font-weight="bold" text-anchor="middle">Cátodo (-)</text>
    <text x="105" y="253" fill="#88AABF" font-size="11" text-anchor="middle">Pata más corta</text>
  </g>

  <!-- Circuito de Conexión Segura con Resistencia -->
  <g transform="translate(420, 120)">
    <rect x="0" y="0" width="340" height="300" rx="10" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="20" y="32" fill="#00B7FF" font-size="15" font-weight="bold">CIRCUITO BÁSICO SEGURO</text>

    <!-- Fuente 5V -->
    <text x="40" y="90" fill="#FFCC00" font-size="13" font-weight="bold">+5V Vcc</text>
    <circle cx="95" cy="85" r="5" fill="#FFCC00"/>

    <line x1="95" y1="85" x2="140" y2="85" stroke="#00E5FF" stroke-width="2.5"/>

    <!-- Resistencia 330 ohms -->
    <rect x="140" y="75" width="50" height="20" fill="#D9B78C" stroke="#7A3E1D" stroke-width="2"/>
    <line x1="152" y1="75" x2="152" y2="95" stroke="#FF5252" stroke-width="3"/>
    <line x1="164" y1="75" x2="164" y2="95" stroke="#FF5252" stroke-width="3"/>
    <line x1="176" y1="75" x2="176" y2="95" stroke="#7A3E1D" stroke-width="3"/>
    <text x="165" y="65" fill="#FFF" font-size="11" text-anchor="middle">R = 330 Ω</text>

    <line x1="190" y1="85" x2="230" y2="85" stroke="#00E5FF" stroke-width="2.5"/>

    <!-- Símbolo LED -->
    <g transform="translate(230, 85)">
      <!-- Triángulo -->
      <polygon points="0,-15 0,15 25,0" fill="#00FFAA" stroke="#00FFAA" stroke-width="1.5"/>
      <!-- Barra cátodo -->
      <line x1="25" y1="-16" x2="25" y2="16" stroke="#00FFAA" stroke-width="3"/>
      <!-- Flechas de luz emitida -->
      <line x1="12" y1="-18" x2="22" y2="-28" stroke="#FFEB3B" stroke-width="2"/>
      <polygon points="20,-30 25,-26 22,-22" fill="#FFEB3B"/>
      <line x1="22" y1="-14" x2="32" y2="-24" stroke="#FFEB3B" stroke-width="2"/>
      <polygon points="30,-26 35,-22 32,-18" fill="#FFEB3B"/>
    </g>

    <line x1="255" y1="85" x2="290" y2="85" stroke="#00E5FF" stroke-width="2.5"/>
    <line x1="290" y1="85" x2="290" y2="180" stroke="#00E5FF" stroke-width="2.5"/>
    <line x1="290" y1="180" x2="95" y2="180" stroke="#00E5FF" stroke-width="2.5"/>

    <!-- Tierra GND -->
    <line x1="95" y1="180" x2="95" y2="200" stroke="#00E5FF" stroke-width="2.5"/>
    <line x1="80" y1="200" x2="110" y2="200" stroke="#00E5FF" stroke-width="3"/>
    <line x1="85" y1="206" x2="105" y2="206" stroke="#00E5FF" stroke-width="2"/>
    <line x1="90" y1="212" x2="100" y2="212" stroke="#00E5FF" stroke-width="1.5"/>
    <text x="95" y="235" fill="#88AABF" font-size="12" text-anchor="middle">GND (Tierra 0V)</text>

    <!-- Fórmula -->
    <rect x="20" y="248" width="300" height="38" rx="6" fill="#041527"/>
    <text x="170" y="272" fill="#00FFAA" font-size="12" font-weight="bold" text-anchor="middle">R = (V_fuente - V_led) / I = (5V - 2V) / 0.015A ≈ 200–330 Ω</text>
  </g>
</svg>`),
    };
  }

  // 3. Diodo semiconductor y rectificador
  if (/\bdiodo\b|\bdiode\b|union\s+pn|rectificador/.test(t) && !/emisor|\bled\b/.test(t)) {
    return {
      topic: 'diodo',
      title: 'Diodo Semiconductor y Unión P-N',
      isVerified: true,
      description: 'Componente que permite el flujo de corriente en un solo sentido: símbolo esquemático, encapsulado 1N4007, unión P-N y polarización directa.',
      components: ['Ánodo (A, polo positivo)', 'Cátodo (K, polo negativo / banda)', 'Símbolo esquemático (triángulo y barra)', 'Cuerpo físico 1N4007', 'Unión P-N con barrera de 0.7V', 'Polarización directa (conducción)'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <defs>
    <filter id="diodeGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <rect width="800" height="480" fill="#041527" rx="12"/>
  <rect x="20" y="20" width="760" height="440" fill="none" stroke="#00B7FF" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.3" rx="8"/>

  <!-- Encabezado -->
  <text x="40" y="52" fill="#00E5FF" font-size="20" font-weight="bold" filter="url(#diodeGlow)">DIODO RECTIFICADOR Y UNIÓN P-N</text>
  <text x="40" y="74" fill="#88AABF" font-size="12">Semiconductor que permite el flujo de corriente en un solo sentido: Ánodo (A, +) → Cátodo (K, -)</text>

  <!-- 1. SÍMBOLO ESQUEMÁTICO (Superior Izquierda) -->
  <g transform="translate(40, 95)">
    <rect x="0" y="0" width="345" height="150" rx="8" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="18" y="26" fill="#00E5FF" font-size="13" font-weight="bold">1. SÍMBOLO ESQUEMÁTICO</text>

    <!-- Terminal Ánodo (Izquierda) -->
    <line x1="30" y1="75" x2="110" y2="75" stroke="#00FFAA" stroke-width="4"/>
    <circle cx="30" cy="75" r="5" fill="#00FFAA"/>
    <text x="30" y="105" fill="#00FFAA" font-size="14" font-weight="bold" text-anchor="middle">Ánodo (A)</text>
    <text x="30" y="122" fill="#88AABF" font-size="11" text-anchor="middle">[ Polo + ]</text>

    <!-- Triángulo que apunta hacia el cátodo -->
    <polygon points="110,45 110,105 170,75" fill="#00E5FF" stroke="#00E5FF" stroke-width="2"/>
    <!-- Barra vertical en el vértice (Cátodo) -->
    <line x1="170" y1="43" x2="170" y2="107" stroke="#FF5252" stroke-width="5" stroke-linecap="round"/>

    <!-- Terminal Cátodo (Derecha) -->
    <line x1="170" y1="75" x2="250" y2="75" stroke="#FF5252" stroke-width="4"/>
    <circle cx="250" cy="75" r="5" fill="#FF5252"/>
    <text x="250" y="105" fill="#FF5252" font-size="14" font-weight="bold" text-anchor="middle">Cátodo (K)</text>
    <text x="250" y="122" fill="#88AABF" font-size="11" text-anchor="middle">[ Polo - ]</text>

    <!-- Flecha de corriente convencional (I) de Ánodo a Cátodo -->
    <path d="M 85 45 Q 140 32 195 45" fill="none" stroke="#FFD54F" stroke-width="2.5" stroke-dasharray="4,2"/>
    <polygon points="198,47 190,40 192,48" fill="#FFD54F"/>
    <text x="140" y="32" fill="#FFD54F" font-size="11" font-weight="bold" text-anchor="middle">Corriente (I) →</text>
  </g>

  <!-- 2. COMPONENTE FÍSICO REAL (Superior Derecha) -->
  <g transform="translate(415, 95)">
    <rect x="0" y="0" width="345" height="150" rx="8" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="18" y="26" fill="#00E5FF" font-size="13" font-weight="bold">2. COMPONENTE FÍSICO (Ej. 1N4007)</text>

    <!-- Terminales axiales -->
    <line x1="30" y1="75" x2="100" y2="75" stroke="#B0C4DE" stroke-width="5" stroke-linecap="round"/>
    <line x1="240" y1="75" x2="315" y2="75" stroke="#B0C4DE" stroke-width="5" stroke-linecap="round"/>

    <!-- Cuerpo cilíndrico del diodo -->
    <rect x="100" y="50" width="140" height="50" rx="6" fill="#17202A" stroke="#2C3E50" stroke-width="2"/>
    <!-- Banda plateada indicadora del Cátodo -->
    <rect x="215" y="50" width="18" height="50" fill="#D5DBDB"/>

    <!-- Texto en el encapsulado -->
    <text x="155" y="80" fill="#7F8C8D" font-size="11" font-family="monospace" font-weight="bold">1N4007</text>

    <!-- Indicador de Banda -->
    <line x1="224" y1="42" x2="224" y2="28" stroke="#FF5252" stroke-width="1.5"/>
    <text x="224" y="22" fill="#FF5252" font-size="10" font-weight="bold" text-anchor="middle">Banda plateada = CÁTODO (-)</text>

    <!-- Etiquetas Ánodo / Cátodo -->
    <text x="65" y="112" fill="#00FFAA" font-size="12" font-weight="bold" text-anchor="middle">Ánodo (+)</text>
    <text x="277" y="112" fill="#FF5252" font-size="12" font-weight="bold" text-anchor="middle">Cátodo (-)</text>
  </g>

  <!-- 3. ESTRUCTURA INTERNA: UNIÓN P-N (Inferior Izquierda) -->
  <g transform="translate(40, 260)">
    <rect x="0" y="0" width="345" height="185" rx="8" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="18" y="24" fill="#00E5FF" font-size="13" font-weight="bold">3. ESTRUCTURA INTERNA: UNIÓN P-N</text>

    <!-- Semiconductor Tipo P (Ánodo) -->
    <rect x="40" y="45" width="115" height="70" rx="4" fill="#154360" stroke="#1F618D" stroke-width="2"/>
    <text x="97" y="68" fill="#5DADE2" font-size="14" font-weight="bold" text-anchor="middle">TIPO P</text>
    <text x="97" y="86" fill="#A9CCE3" font-size="10" text-anchor="middle">Ánodo (+)</text>
    <text x="97" y="103" fill="#D4E6F1" font-size="9" text-anchor="middle">Huecos (+ mayoritarios)</text>

    <!-- Zona de Agotamiento (Barrera) -->
    <rect x="155" y="45" width="35" height="70" fill="#17202A" stroke="#F39C12" stroke-width="1.5" stroke-dasharray="2,2"/>
    <text x="172" y="128" fill="#F39C12" font-size="9" font-weight="bold" text-anchor="middle">Barrera: ~0.7 V (Si)</text>

    <!-- Semiconductor Tipo N (Cátodo) -->
    <rect x="190" y="45" width="115" height="70" rx="4" fill="#0E4B38" stroke="#148F77" stroke-width="2"/>
    <text x="247" y="68" fill="#48C9B0" font-size="14" font-weight="bold" text-anchor="middle">TIPO N</text>
    <text x="247" y="86" fill="#A3E4D7" font-size="10" text-anchor="middle">Cátodo (-)</text>
    <text x="247" y="103" fill="#D1F2EB" font-size="9" text-anchor="middle">Electrones (- mayoritarios)</text>

    <text x="172" y="155" fill="#88AABF" font-size="11" text-anchor="middle">Al superar los 0.7V en Silicio, los portadores</text>
    <text x="172" y="172" fill="#88AABF" font-size="11" text-anchor="middle">cruzan la unión y permiten la conducción.</text>
  </g>

  <!-- 4. POLARIZACIÓN DIRECTA (Inferior Derecha) -->
  <g transform="translate(415, 260)">
    <rect x="0" y="0" width="345" height="185" rx="8" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="18" y="24" fill="#00E5FF" font-size="13" font-weight="bold">4. POLARIZACIÓN DIRECTA (CONDUCCIÓN)</text>

    <!-- Circuito de polarización directa -->
    <!-- Batería: Polo + a la izquierda (hacia ánodo), Polo - a la derecha (hacia cátodo) -->
    <g transform="translate(30, 40)">
      <!-- Fuente -->
      <line x1="20" y1="35" x2="20" y2="65" stroke="#00FFAA" stroke-width="4"/> <!-- Barra larga + -->
      <line x1="30" y1="42" x2="30" y2="58" stroke="#FF5252" stroke-width="5"/> <!-- Barra corta - -->
      <text x="12" y="42" fill="#00FFAA" font-size="12" font-weight="bold">+</text>
      <text x="36" y="42" fill="#FF5252" font-size="12" font-weight="bold">-</text>

      <!-- Cable superior hacia Ánodo -->
      <path d="M 20 35 L 20 15 L 90 15" fill="none" stroke="#00FFAA" stroke-width="2.5"/>

      <!-- Símbolo Diodo en circuito -->
      <g transform="translate(90, 15)">
        <polygon points="0,-12 0,12 24,0" fill="#00FFAA"/>
        <line x1="24" y1="-14" x2="24" y2="14" stroke="#00FFAA" stroke-width="3"/>
      </g>

      <!-- Cable superior hacia resistencia limitadora -->
      <line x1="114" y1="15" x2="155" y2="15" stroke="#00E5FF" stroke-width="2.5"/>
      <rect x="155" y="8" width="45" height="14" fill="#D9B78C" stroke="#7A3E1D" stroke-width="1.5"/>
      <text x="177" y="5" fill="#D9B78C" font-size="9" text-anchor="middle">R (Carga)</text>
      <line x1="200" y1="15" x2="250" y2="15" stroke="#FF5252" stroke-width="2.5"/>

      <!-- Retorno al polo negativo -->
      <path d="M 250 15 L 250 85 L 30 85 L 30 58" fill="none" stroke="#FF5252" stroke-width="2.5"/>

      <!-- Flechas animadas o de flujo de corriente -->
      <path d="M 45 6 Q 65 0 85 6" fill="none" stroke="#00FFAA" stroke-width="2"/>
      <polygon points="87,7 80,2 81,9" fill="#00FFAA"/>
      <text x="65" y="-2" fill="#00FFAA" font-size="10" font-weight="bold" text-anchor="middle">I &gt; 0 (Pasa)</text>
    </g>

    <rect x="20" y="132" width="305" height="42" rx="6" fill="#041527"/>
    <text x="172" y="150" fill="#00FFAA" font-size="11" font-weight="bold" text-anchor="middle">V_ánodo &gt; V_cátodo (+0.7V): INTERRUPTOR CERRADO (ON)</text>
    <text x="172" y="166" fill="#88AABF" font-size="10" text-anchor="middle">Si se invierte (polarización inversa), el diodo bloquea (OFF).</text>
  </g>
</svg>`),
    };
  }

  // 4. Placa madre (Motherboard)
  if (/placa\s+madre|motherboard|tarjeta\s+madre|mainboard/.test(t)) {
    return {
      topic: 'placa_madre',
      title: 'Arquitectura Topológica de Placa Madre (Motherboard ATX)',
      isVerified: true,
      description: 'Mapa de componentes principales: Socket CPU, fases VRM, ranuras RAM, PCIe x16, ranuras M.2 NVMe, chipset y puertos I/O.',
      components: ['Socket CPU', 'Slots RAM Dual-Channel', 'Slot PCIe x16 (GPU)', 'Slots M.2 NVMe', 'Chipset', 'VRM Disipador', 'Panel I/O Trasero', 'Conector ATX 24 Pines'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 520" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#03111E; font-family:system-ui, sans-serif;">
  <rect width="800" height="520" fill="#03111E" rx="12"/>

  <!-- Encabezado -->
  <text x="40" y="42" fill="#00E5FF" font-size="20" font-weight="bold">ARQUITECTURA DE LA PLACA MADRE (MOTHERBOARD)</text>
  <text x="40" y="64" fill="#88AABF" font-size="12">Plataforma central que interconecta CPU, memoria RAM, almacenamiento y tarjetas de expansión</text>

  <!-- PCB Base -->
  <rect x="60" y="85" width="680" height="400" rx="14" fill="#0B2B1B" stroke="#105634" stroke-width="4"/>

  <!-- Panel I/O Trasero (Superior izquierdo) -->
  <rect x="60" y="95" width="45" height="180" rx="4" fill="#4A6572" stroke="#232F34" stroke-width="2"/>
  <text x="82" y="190" fill="#FFF" font-size="11" font-weight="bold" transform="rotate(-90 82 190)" text-anchor="middle">PANEL TRASERO I/O</text>

  <!-- VRM Disipador (Alrededor del CPU) -->
  <rect x="130" y="105" width="50" height="160" rx="4" fill="#2C3E50" stroke="#34495E" stroke-width="2"/>
  <rect x="180" y="105" width="150" height="40" rx="4" fill="#2C3E50" stroke="#34495E" stroke-width="2"/>
  <text x="155" y="190" fill="#7F8C8D" font-size="10" transform="rotate(-90 155 190)" text-anchor="middle">VRM (Alimentación)</text>

  <!-- Socket CPU -->
  <rect x="200" y="160" width="130" height="130" rx="6" fill="#1C2833" stroke="#F39C12" stroke-width="3"/>
  <rect x="215" y="175" width="100" height="100" fill="#17202A"/>
  <circle cx="265" cy="225" r="16" fill="#F39C12" opacity="0.3"/>
  <text x="265" y="222" fill="#F1C40F" font-size="13" font-weight="bold" text-anchor="middle">SOCKET</text>
  <text x="265" y="238" fill="#F1C40F" font-size="11" text-anchor="middle">CPU (Procesador)</text>

  <!-- Ranuras RAM (DIMM) -->
  <g transform="translate(365, 120)">
    <rect x="0" y="0" width="18" height="190" rx="2" fill="#1A5276" stroke="#2980B9" stroke-width="1.5"/>
    <rect x="26" y="0" width="18" height="190" rx="2" fill="#117A65" stroke="#1ABC9C" stroke-width="1.5"/>
    <rect x="52" y="0" width="18" height="190" rx="2" fill="#1A5276" stroke="#2980B9" stroke-width="1.5"/>
    <rect x="78" y="0" width="18" height="190" rx="2" fill="#117A65" stroke="#1ABC9C" stroke-width="1.5"/>
    <text x="48" y="215" fill="#00E5FF" font-size="12" font-weight="bold" text-anchor="middle">4× SLOTS RAM (DDR4 / DDR5)</text>
    <text x="48" y="230" fill="#88AABF" font-size="10" text-anchor="middle">Arquitectura Dual-Channel</text>
  </g>

  <!-- Conector ATX 24 Pines -->
  <rect x="495" y="150" width="30" height="130" rx="3" fill="#D35400" stroke="#E67E22" stroke-width="2"/>
  <text x="540" y="220" fill="#E67E22" font-size="11" font-weight="bold">ATX 24-PIN (Poder)</text>

  <!-- Ranura PCIe x16 Principal (Para Tarjeta Gráfica GPU) -->
  <g transform="translate(130, 320)">
    <rect x="0" y="0" width="320" height="24" rx="3" fill="#B03A2E" stroke="#E74C3C" stroke-width="2"/>
    <rect x="20" y="4" width="70" height="16" fill="#78281F"/>
    <rect x="100" y="4" width="200" height="16" fill="#78281F"/>
    <text x="160" y="17" fill="#FFF" font-size="11" font-weight="bold" text-anchor="middle">PCIe 4.0 / 5.0 x16 (GPU - Tarjeta Gráfica)</text>
  </g>

  <!-- Ranura M.2 NVMe SSD -->
  <g transform="translate(160, 360)">
    <rect x="0" y="0" width="160" height="30" rx="4" fill="#34495E" stroke="#5D6D7E" stroke-width="1.5"/>
    <text x="80" y="20" fill="#00FFAA" font-size="11" font-weight="bold" text-anchor="middle">Slot M.2 NVMe (SSD)</text>
  </g>

  <!-- Ranura PCIe x1 -->
  <g transform="translate(130, 410)">
    <rect x="0" y="0" width="90" height="18" rx="2" fill="#566573" stroke="#808B96" stroke-width="1.5"/>
    <text x="45" y="13" fill="#FFF" font-size="9" text-anchor="middle">PCIe x1</text>
  </g>

  <!-- Chipset (Southbridge) -->
  <rect x="510" y="340" width="110" height="90" rx="6" fill="#1F618D" stroke="#2980B9" stroke-width="2.5"/>
  <text x="565" y="380" fill="#FFF" font-size="14" font-weight="bold" text-anchor="middle">CHIPSET</text>
  <text x="565" y="400" fill="#AED6F1" font-size="11" text-anchor="middle">Controlador I/O</text>

  <!-- Pila CMOS -->
  <circle cx="390" cy="410" r="22" fill="#BDC3C7" stroke="#7F8C8D" stroke-width="3"/>
  <text x="390" y="415" fill="#2C3E50" font-size="10" font-weight="bold" text-anchor="middle">CR2032</text>
  <text x="390" y="445" fill="#88AABF" font-size="10" text-anchor="middle">Pila BIOS</text>

  <!-- Puertos SATA -->
  <g transform="translate(650, 350)">
    <rect x="0" y="0" width="30" height="20" fill="#922B21" rx="2"/>
    <rect x="0" y="30" width="30" height="20" fill="#922B21" rx="2"/>
    <rect x="0" y="60" width="30" height="20" fill="#922B21" rx="2"/>
    <text x="-10" y="45" fill="#E74C3C" font-size="10" font-weight="bold" text-anchor="end">SATA 6Gb/s</text>
  </g>
</svg>`),
    };
  }

  // 5. Arquitectura de Von Neumann
  if (/von\s+neumann|arquitectura\s+del?\s+computador|\balu\b|unidad\s+de\s+control/.test(t)) {
    return {
      topic: 'arquitectura_von_neumann',
      title: 'Modelo y Arquitectura de Von Neumann',
      isVerified: true,
      description: 'Estructura clásica de computación: CPU (Unidad de Control y ALU), Memoria Principal y Buses del Sistema.',
      components: ['Unidad Central de Procesamiento (CPU)', 'Unidad de Control (UC)', 'Unidad Aritmético-Lógica (ALU)', 'Memoria Principal (RAM)', 'Bus de Datos, Control y Direcciones'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <rect width="800" height="480" fill="#041527" rx="12"/>
  <text x="40" y="50" fill="#00E5FF" font-size="20" font-weight="bold">ARQUITECTURA DE VON NEUMANN</text>
  <text x="40" y="74" fill="#88AABF" font-size="12">Base teórica del computador digital: procesamiento secuencial, programa almacenado y buses compartidos</text>

  <!-- Bloque CPU -->
  <rect x="60" y="110" width="320" height="240" rx="10" fill="#07223D" stroke="#00B7FF" stroke-width="2.5"/>
  <text x="220" y="140" fill="#00E5FF" font-size="16" font-weight="bold" text-anchor="middle">CPU (PROCESADOR)</text>

  <!-- Unidad de Control -->
  <rect x="85" y="160" width="270" height="60" rx="6" fill="#133D63" stroke="#00FFAA" stroke-width="1.5"/>
  <text x="220" y="188" fill="#00FFAA" font-size="14" font-weight="bold" text-anchor="middle">UNIDAD DE CONTROL (UC)</text>
  <text x="220" y="206" fill="#A0C8DF" font-size="11" text-anchor="middle">Decodifica instrucciones y coordina señales</text>

  <!-- ALU -->
  <rect x="85" y="240" width="270" height="60" rx="6" fill="#133D63" stroke="#FF9900" stroke-width="1.5"/>
  <text x="220" y="268" fill="#FFB74D" font-size="14" font-weight="bold" text-anchor="middle">UNIDAD ARITMÉTICO-LÓGICA (ALU)</text>
  <text x="220" y="286" fill="#A0C8DF" font-size="11" text-anchor="middle">Operaciones matemáticas y lógicas (AND, OR, SUMA)</text>

  <!-- Bloque Memoria Principal -->
  <rect x="480" y="110" width="260" height="110" rx="10" fill="#0E332A" stroke="#00FFAA" stroke-width="2"/>
  <text x="610" y="145" fill="#00FFAA" font-size="16" font-weight="bold" text-anchor="middle">MEMORIA PRINCIPAL (RAM)</text>
  <text x="610" y="170" fill="#A8DFC5" font-size="12" text-anchor="middle">Instrucciones de programas</text>
  <text x="610" y="190" fill="#A8DFC5" font-size="12" text-anchor="middle">Datos y variables en ejecución</text>

  <!-- Dispositivos de Entrada / Salida (I/O) -->
  <rect x="480" y="240" width="260" height="110" rx="10" fill="#2D1D45" stroke="#BA68C8" stroke-width="2"/>
  <text x="610" y="275" fill="#E1BEE7" font-size="16" font-weight="bold" text-anchor="middle">DISPOSITIVOS E/S (I/O)</text>
  <text x="610" y="300" fill="#D1C4E9" font-size="12" text-anchor="middle">Entrada: Teclado, Ratón, Micrófono</text>
  <text x="610" y="320" fill="#D1C4E9" font-size="12" text-anchor="middle">Salida: Monitor, Parlantes, Impresora</text>

  <!-- Buses del Sistema (Zona inferior) -->
  <g transform="translate(60, 380)">
    <rect x="0" y="0" width="680" height="75" rx="8" fill="#081A2A" stroke="#FFD54F" stroke-width="1.5"/>

    <line x1="20" y1="20" x2="660" y2="20" stroke="#FF5252" stroke-width="4"/>
    <text x="340" y="16" fill="#FF8A80" font-size="11" font-weight="bold" text-anchor="middle">BUS DE CONTROL (Señales de reloj, lectura/escritura)</text>

    <line x1="20" y1="42" x2="660" y2="42" stroke="#40C4FF" stroke-width="5"/>
    <text x="340" y="39" fill="#80D8FF" font-size="11" font-weight="bold" text-anchor="middle">BUS DE DIRECCIONES (Unidireccional: ubicación en memoria)</text>

    <line x1="20" y1="64" x2="660" y2="64" stroke="#69F0AE" stroke-width="6"/>
    <text x="340" y="61" fill="#B9F6CA" font-size="11" font-weight="bold" text-anchor="middle">BUS DE DATOS (Bidireccional: transfiere bytes)</text>
  </g>

  <!-- Conectores verticales -->
  <line x1="220" y1="350" x2="220" y2="380" stroke="#00E5FF" stroke-width="3" stroke-dasharray="4,2"/>
  <line x1="610" y1="220" x2="610" y2="240" stroke="#BA68C8" stroke-width="2"/>
  <line x1="610" y1="350" x2="610" y2="380" stroke="#00FFAA" stroke-width="3" stroke-dasharray="4,2"/>
</svg>`),
    };
  }

  // 5. Transistor BJT NPN (Interruptor y amplificador)
  if (/transistor|bjt|npn|pnp/.test(t)) {
    return {
      topic: 'transistor_npn',
      title: 'Transistor BJT NPN (Interruptor Electrónico)',
      isVerified: true,
      description: 'Esquema de terminales: Base (B), Colector (C) y Emisor (E), y funcionamiento como interruptor para cargas.',
      components: ['Base (B)', 'Colector (C)', 'Emisor (E)', 'Corriente de base (Ib)', 'Corriente de colector (Ic)'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <rect width="800" height="480" fill="#041527" rx="12"/>
  <text x="40" y="50" fill="#00FFAA" font-size="20" font-weight="bold">TRANSISTOR BIPOLAR BJT (NPN)</text>
  <text x="40" y="74" fill="#88AABF" font-size="12">Componente semiconductor de 3 terminales: actúa como interruptor digital (0/1) o amplificador de corriente</text>

  <!-- Símbolo NPN Grande Central -->
  <g transform="translate(180, 140)">
    <circle cx="100" cy="100" r="70" fill="#07223D" stroke="#00FFAA" stroke-width="3"/>

    <!-- Barra de la Base -->
    <line x1="75" y1="65" x2="75" y2="135" stroke="#FFF" stroke-width="6"/>

    <!-- Terminal Base -->
    <line x1="20" y1="100" x2="75" y2="100" stroke="#00E5FF" stroke-width="4"/>
    <text x="5" y="105" fill="#00E5FF" font-size="16" font-weight="bold">B</text>
    <text x="5" y="125" fill="#88AABF" font-size="11">Base</text>

    <!-- Terminal Colector -->
    <line x1="75" y1="80" x2="125" y2="40" stroke="#FF5252" stroke-width="4"/>
    <line x1="125" y1="40" x2="125" y2="0" stroke="#FF5252" stroke-width="4"/>
    <text x="135" y="25" fill="#FF5252" font-size="16" font-weight="bold">C (Colector)</text>

    <!-- Terminal Emisor (Con flecha hacia afuera para NPN) -->
    <line x1="75" y1="120" x2="125" y2="160" stroke="#FFEB3B" stroke-width="4"/>
    <line x1="125" y1="160" x2="125" y2="200" stroke="#FFEB3B" stroke-width="4"/>
    <polygon points="120,150 128,162 114,162" fill="#FFEB3B"/>
    <text x="135" y="195" fill="#FFEB3B" font-size="16" font-weight="bold">E (Emisor)</text>
  </g>

  <!-- Panel de Funcionamiento como Interruptor -->
  <g transform="translate(430, 110)">
    <rect x="0" y="0" width="330" height="320" rx="10" fill="#071E36" stroke="#00B7FF" stroke-width="1.5"/>
    <text x="20" y="35" fill="#00E5FF" font-size="15" font-weight="bold">FUNCIONAMIENTO: INTERRUPTOR</text>

    <!-- Estado 1: Corte (OFF) -->
    <rect x="15" y="55" width="300" height="110" rx="6" fill="#0E2844"/>
    <text x="30" y="80" fill="#FF5252" font-size="13" font-weight="bold">1. CORTE (Interruptor ABIERTO - 0 Lógico):</text>
    <text x="30" y="105" fill="#C5D9E8" font-size="12">• Voltaje en Base Vb &lt; 0.7 V</text>
    <text x="30" y="125" fill="#C5D9E8" font-size="12">• Corriente de Base Ib = 0</text>
    <text x="30" y="145" fill="#C5D9E8" font-size="12">• No pasa corriente al Colector (Ic = 0). Carga apagada.</text>

    <!-- Estado 2: Saturación (ON) -->
    <rect x="15" y="180" width="300" height="115" rx="6" fill="#0E2844"/>
    <text x="30" y="205" fill="#00FFAA" font-size="13" font-weight="bold">2. SATURACIÓN (Interruptor CERRADO - 1 Lógico):</text>
    <text x="30" y="230" fill="#C5D9E8" font-size="12">• Voltaje en Base Vb ≥ 0.7 V</text>
    <text x="30" y="250" fill="#C5D9E8" font-size="12">• Una pequeña corriente Ib activa una gran corriente Ic</text>
    <text x="30" y="270" fill="#C5D9E8" font-size="12">• Resistencia entre C y E casi nula. Carga encendida.</text>
  </g>
</svg>`),
    };
  }

  // 7. Ley de Ohm y fórmulas de potencia
  if (/ley\s+de\s+ohm|triangulo\s+de\s+ohm|\bohm\b|voltaje\s+corriente\s+resistencia/.test(t)) {
    return {
      topic: 'ley_de_ohm',
      title: 'Triángulo de la Ley de Ohm y Potencia Eléctrica',
      isVerified: true,
      description: 'Relación fundamental entre Voltaje (V), Corriente (I) y Resistencia (R), junto a potencia en Vatios (W).',
      components: ['Voltaje (Voltios, V)', 'Intensidad / Corriente (Amperios, A)', 'Resistencia (Ohmios, Ω)', 'Potencia (Vatios, W)'],
      svg: sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <rect width="800" height="480" fill="#041527" rx="12"/>
  <text x="40" y="50" fill="#FFD54F" font-size="20" font-weight="bold">LEY DE OHM Y POTENCIA ELÉCTRICA</text>
  <text x="40" y="74" fill="#88AABF" font-size="12">Principio elemental de los circuitos: la corriente es directamente proporcional al voltaje e inversamente a la resistencia</text>

  <!-- Triángulo de Ohm -->
  <g transform="translate(140, 110)">
    <!-- Triángulo Exterior -->
    <polygon points="150,20 20,240 280,240" fill="#08233C" stroke="#00E5FF" stroke-width="4"/>

    <!-- Línea divisoria horizontal -->
    <line x1="63" y1="160" x2="237" y2="160" stroke="#00E5FF" stroke-width="3"/>
    <!-- Línea divisoria vertical inferior -->
    <line x1="150" y1="160" x2="150" y2="240" stroke="#00E5FF" stroke-width="3"/>

    <!-- Letras -->
    <text x="150" y="125" fill="#FFD54F" font-size="44" font-weight="bold" text-anchor="middle">V</text>
    <text x="100" y="215" fill="#00FFAA" font-size="38" font-weight="bold" text-anchor="middle">I</text>
    <text x="200" y="215" fill="#FF6B6B" font-size="38" font-weight="bold" text-anchor="middle">R</text>

    <!-- Etiquetas explicativas -->
    <text x="150" y="275" fill="#88AABF" font-size="13" text-anchor="middle">Tapa la variable que deseas calcular:</text>
  </g>

  <!-- Fórmulas Derivadas -->
  <g transform="translate(460, 110)">
    <!-- V = I * R -->
    <rect x="0" y="10" width="280" height="65" rx="8" fill="#07223D" stroke="#FFD54F" stroke-width="1.5"/>
    <text x="20" y="38" fill="#FFD54F" font-size="18" font-weight="bold">V = I × R</text>
    <text x="20" y="58" fill="#A0C8DF" font-size="12">Tensión / Voltaje (en Voltios [V])</text>

    <!-- I = V / R -->
    <rect x="0" y="90" width="280" height="65" rx="8" fill="#07223D" stroke="#00FFAA" stroke-width="1.5"/>
    <text x="20" y="118" fill="#00FFAA" font-size="18" font-weight="bold">I = V / R</text>
    <text x="20" y="138" fill="#A0C8DF" font-size="12">Intensidad / Corriente (en Amperios [A])</text>

    <!-- R = V / I -->
    <rect x="0" y="170" width="280" height="65" rx="8" fill="#07223D" stroke="#FF6B6B" stroke-width="1.5"/>
    <text x="20" y="198" fill="#FF6B6B" font-size="18" font-weight="bold">R = V / I</text>
    <text x="20" y="218" fill="#A0C8DF" font-size="12">Resistencia Eléctrica (en Ohmios [Ω])</text>

    <!-- Potencia P = V * I -->
    <rect x="0" y="250" width="280" height="65" rx="8" fill="#07223D" stroke="#00E5FF" stroke-width="1.5"/>
    <text x="20" y="278" fill="#00E5FF" font-size="18" font-weight="bold">P = V × I = I² × R</text>
    <text x="20" y="298" fill="#A0C8DF" font-size="12">Potencia consumida (en Vatios [W])</text>
  </g>
</svg>`),
    };
  }

  return null;
}

/* ==========================================================================
   5. GENERADOR DINÁMICO DE DIAGRAMAS SVG EDUCATIVOS (Fallback inteligente)
   ========================================================================== */

export function generateEducationalSvgDiagram(topic: string, details?: string): DiagramResult {
  const cleanTitle = String(topic || 'Diagrama Técnico').slice(0, 60);
  const subtitle = details ? String(details).slice(0, 100) : 'Esquema educativo generado por XR Hand Lab Edu';

  // SVG estructurado, limpio y estilizado con estética técnica
  const svg = sanitizeSvg(`
<svg viewBox="0 0 800 480" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="background:#041527; font-family:system-ui, sans-serif;">
  <rect width="800" height="480" fill="#041527" rx="12"/>
  <rect x="25" y="25" width="750" height="430" fill="none" stroke="#00B7FF" stroke-width="1.5" stroke-dasharray="5,5" opacity="0.3" rx="8"/>

  <!-- Encabezado -->
  <text x="50" y="60" fill="#00E5FF" font-size="20" font-weight="bold">${escapeXml(cleanTitle.toUpperCase())}</text>
  <text x="50" y="85" fill="#88AABF" font-size="13">${escapeXml(subtitle)}</text>

  <!-- Bloque 1: Entrada / Origen -->
  <g transform="translate(60, 140)">
    <rect x="0" y="0" width="180" height="180" rx="8" fill="#08223C" stroke="#00E5FF" stroke-width="2"/>
    <circle cx="90" cy="50" r="24" fill="#00E5FF" opacity="0.2"/>
    <text x="90" y="56" fill="#00E5FF" font-size="18" font-weight="bold" text-anchor="middle">IN</text>
    <text x="90" y="105" fill="#FFF" font-size="14" font-weight="bold" text-anchor="middle">Entrada / Fuente</text>
    <text x="90" y="130" fill="#88AABF" font-size="11" text-anchor="middle">Tensión y Señal</text>
    <rect x="20" y="150" width="140" height="18" rx="4" fill="#00E5FF" opacity="0.15"/>
    <text x="90" y="163" fill="#00E5FF" font-size="10" text-anchor="middle">Estado: ACTIVO</text>
  </g>

  <!-- Bus / Enlace 1 -->
  <g transform="translate(240, 220)">
    <line x1="0" y1="10" x2="60" y2="10" stroke="#00FFAA" stroke-width="4"/>
    <polygon points="60,10 50,4 50,16" fill="#00FFAA"/>
    <text x="30" y="-4" fill="#00FFAA" font-size="10" text-anchor="middle">Flujo de datos</text>
  </g>

  <!-- Bloque 2: Procesamiento / Núcleo Central -->
  <g transform="translate(310, 120)">
    <rect x="0" y="0" width="200" height="220" rx="10" fill="#0B2B47" stroke="#FFD54F" stroke-width="2.5"/>
    <rect x="20" y="20" width="160" height="40" rx="5" fill="#1A3E60"/>
    <text x="100" y="45" fill="#FFD54F" font-size="14" font-weight="bold" text-anchor="middle">NÚCLEO ACTIVO</text>
    <text x="100" y="90" fill="#FFF" font-size="13" font-weight="bold" text-anchor="middle">${escapeXml(cleanTitle)}</text>
    <text x="100" y="115" fill="#88AABF" font-size="11" text-anchor="middle">Módulo de control</text>

    <!-- Puntos de prueba / Buses internos -->
    <line x1="30" y1="140" x2="170" y2="140" stroke="#00FFAA" stroke-width="2" stroke-dasharray="3,3"/>
    <circle cx="50" cy="140" r="4" fill="#00FFAA"/>
    <circle cx="100" cy="140" r="4" fill="#FFD54F"/>
    <circle cx="150" cy="140" r="4" fill="#FF5252"/>
    <text x="100" y="165" fill="#A0C8DF" font-size="10" text-anchor="middle">Sincronización I/O</text>

    <rect x="25" y="180" width="150" height="24" rx="4" fill="#041527"/>
    <text x="100" y="196" fill="#00E5FF" font-size="11" font-weight="bold" text-anchor="middle">Operación óptima</text>
  </g>

  <!-- Bus / Enlace 2 -->
  <g transform="translate(510, 220)">
    <line x1="0" y1="10" x2="60" y2="10" stroke="#00FFAA" stroke-width="4"/>
    <polygon points="60,10 50,4 50,16" fill="#00FFAA"/>
    <text x="30" y="-4" fill="#00FFAA" font-size="10" text-anchor="middle">Respuesta</text>
  </g>

  <!-- Bloque 3: Salida / Receptor -->
  <g transform="translate(580, 140)">
    <rect x="0" y="0" width="160" height="180" rx="8" fill="#08223C" stroke="#00FFAA" stroke-width="2"/>
    <circle cx="80" cy="50" r="24" fill="#00FFAA" opacity="0.2"/>
    <text x="80" y="56" fill="#00FFAA" font-size="18" font-weight="bold" text-anchor="middle">OUT</text>
    <text x="80" y="105" fill="#FFF" font-size="14" font-weight="bold" text-anchor="middle">Salida / Carga</text>
    <text x="80" y="130" fill="#88AABF" font-size="11" text-anchor="middle">Visualización / Bus</text>
    <rect x="15" y="150" width="130" height="18" rx="4" fill="#00FFAA" opacity="0.15"/>
    <text x="80" y="163" fill="#00FFAA" font-size="10" text-anchor="middle">Verificado</text>
  </g>

  <!-- Pie de diagrama -->
  <rect x="50" y="380" width="700" height="50" rx="6" fill="#07192C" stroke="#00B7FF" stroke-width="1"/>
  <text x="70" y="410" fill="#00FFAA" font-size="12" font-weight="bold">NOTA TÉCNICA:</text>
  <text x="180" y="410" fill="#A0C8DF" font-size="12">Para componentes específicos (CPU, RAM, LED, Resistencia, etc.), consulta la biblioteca técnica integrada.</text>
</svg>`);

  return {
    topic,
    title: cleanTitle,
    isVerified: false,
    description: subtitle,
    svg,
  };
}

function escapeXml(unsafe: string): string {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ==========================================================================
   6. GENERACIÓN MULTI-PROVEEDOR DE IMÁGENES (Sección 2.B y 3)
   ========================================================================== */

export interface GenerateImageOptions {
  prompt: string;
  style?: string;
  aspectRatio?: '1:1' | '16:9' | '4:3' | '3:4' | '9:16';
  provider?: 'auto' | 'cloudflare' | 'gemini' | 'pollinations';
  geminiClient?: GoogleGenAI | null;
}

const imageCache = new Map<string, { dataUrl: string; timestamp: number }>();
const CACHE_TTL_IMAGE = 2 * 60 * 60 * 1000; // 2 horas

export async function generateAiImage(options: GenerateImageOptions): Promise<GeneratedImageResult> {
  const { prompt, style = 'balanced', aspectRatio = '1:1', provider = 'auto', geminiClient } = options;

  // Moderación previa
  const mod = moderateContent(prompt);
  if (!mod.safe) {
    throw new Error(mod.reason || 'Solicitud bloqueada por políticas de protección escolar.');
  }

  // Caché
  const cacheKey = `${provider}|${aspectRatio}|${style}|${prompt.toLowerCase().trim()}`;
  const cached = imageCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_IMAGE) {
    return {
      dataUrl: cached.dataUrl,
      prompt,
      provider: `${provider} (caché)`,
      width: aspectRatio === '16:9' ? 1280 : 1024,
      height: aspectRatio === '16:9' ? 720 : 1024,
    };
  }

  // Enriquecer el prompt con estilo pedagógico y visual
  let enhancedPrompt = prompt.trim();
  if (style === 'technical' || style === 'diagram') {
    enhancedPrompt += ', technical illustration, clean lines, educational scientific schematic, crisp details, no watermark, high clarity';
  } else if (style === 'photorealistic') {
    enhancedPrompt += ', professional studio photography, crisp lighting, high resolution, realistic textures, educational STEM hardware, 8k quality';
  } else if (style === 'isometric') {
    enhancedPrompt += ', 3D isometric render, colorful lighting, high poly, tech lab aesthetic, clean background';
  } else {
    enhancedPrompt += ', high quality educational digital illustration, crisp focus, clear representation, suitable for students, vibrant colors';
  }

  // Dimensiones según relación de aspecto
  let w = 1024;
  let h = 1024;
  if (aspectRatio === '16:9') {
    w = 1280;
    h = 720;
  } else if (aspectRatio === '4:3') {
    w = 1024;
    h = 768;
  } else if (aspectRatio === '9:16') {
    w = 720;
    h = 1280;
  }

  // 1. Cloudflare Workers AI (FLUX schnell / SDXL) si está configurado
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const cfApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();

  if ((provider === 'auto' || provider === 'cloudflare') && cfAccountId && cfApiToken) {
    try {
      const cfRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfApiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: enhancedPrompt, num_steps: 4 }),
        }
      );

      if (cfRes.ok) {
        const contentType = cfRes.headers.get('content-type') || '';
        if (contentType.includes('image/')) {
          const buffer = Buffer.from(await cfRes.arrayBuffer());
          const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
          imageCache.set(cacheKey, { dataUrl, timestamp: Date.now() });
          return { dataUrl, prompt, provider: 'Cloudflare Workers AI (FLUX)', width: w, height: h };
        }
      }
    } catch {
      // Continuar al siguiente proveedor si Cloudflare falla
    }
  }

  // 2. Gemini 3.1 Flash Image (SDK @google/genai)
  if ((provider === 'auto' || provider === 'gemini') && geminiClient && process.env.GEMINI_API_KEY) {
    try {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.1-flash-lite-image',
        contents: {
          parts: [{ text: enhancedPrompt }],
        },
        config: {
          imageConfig: {
            aspectRatio,
          },
        },
      });

      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || 'image/png';
          const dataUrl = `data:${mime};base64,${part.inlineData.data}`;
          imageCache.set(cacheKey, { dataUrl, timestamp: Date.now() });
          return { dataUrl, prompt, provider: 'Gemini 3.1 Flash Image', width: w, height: h };
        }
      }
    } catch {
      // Continuar al siguiente proveedor de respaldo gratuito si Gemini no admite generación de imagen con la clave actual
    }
  }

  // 3. Pollinations FLUX (Respaldo 100% gratuito, sin clave requerida, calidad alta y continua disponibilidad)
  try {
    const seed = Math.floor(Math.random() * 1000000);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
      enhancedPrompt
    )}?width=${w}&height=${h}&nologo=true&seed=${seed}&model=flux`;

    const polRes = await fetch(pollinationsUrl, {
      headers: {
        'User-Agent': 'XRHandLabEdu/1.0',
      },
    });

    if (polRes.ok) {
      const buffer = Buffer.from(await polRes.arrayBuffer());
      const mime = polRes.headers.get('content-type') || 'image/jpeg';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      imageCache.set(cacheKey, { dataUrl, timestamp: Date.now() });
      return { dataUrl, prompt, provider: 'Pollinations AI (FLUX)', width: w, height: h };
    }
  } catch {
    // Si falla la red remota
  }

  throw new Error('No se pudo generar la imagen con los proveedores disponibles. Por favor intenta con otro tema o consulta la biblioteca de diagramas.');
}

/* ==========================================================================
   7. EDICIÓN MULTIMODAL DE IMÁGENES (Sección 2.D)
   ========================================================================== */

export interface EditImageOptions {
  imageBase64: string;
  mimeType: string;
  instruction: string;
  geminiClient?: GoogleGenAI | null;
}

export async function editAiImage(options: EditImageOptions): Promise<GeneratedImageResult> {
  const { imageBase64, mimeType, instruction, geminiClient } = options;

  const mod = moderateContent(instruction);
  if (!mod.safe) {
    throw new Error(mod.reason || 'Instrucción de edición bloqueada por políticas de protección escolar.');
  }

  const cleanBase64 = String(imageBase64).replace(/^data:[^;]+;base64,/, '').trim();
  const safeMime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

  if (geminiClient && process.env.GEMINI_API_KEY) {
    try {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.1-flash-lite-image',
        contents: {
          parts: [
            {
              inlineData: {
                data: cleanBase64,
                mimeType: safeMime,
              },
            },
            {
              text: `Edita esta imagen siguiendo esta instrucción educativa: ${instruction}. Mantén los elementos de hardware y pedagógicos clave, asegurando alta claridad para estudiantes.`,
            },
          ],
        },
      });

      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          const outMime = part.inlineData.mimeType || 'image/png';
          const dataUrl = `data:${outMime};base64,${part.inlineData.data}`;
          return { dataUrl, prompt: instruction, provider: 'Gemini 3.1 Flash Image (Edición)', width: 1024, height: 1024 };
        }
      }
    } catch {
      // Si la edición directa con Gemini no está habilitada en esta cuenta
    }
  }

  // Respaldo de transformación mediante prompt guiado
  return generateAiImage({
    prompt: `Transformación educativa basada en imagen: ${instruction}`,
    style: 'balanced',
    aspectRatio: '1:1',
    provider: 'auto',
    geminiClient,
  });
}
