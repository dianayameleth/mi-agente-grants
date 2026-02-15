// ═══════════════════════════════════════════════════════════
// GRANT PIPELINE INTELLIGENCE — Backend Server v2
// Node.js + Express + Anthropic SDK
// Deploy: Render.com
// ═══════════════════════════════════════════════════════════

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ═══════════════════════════════════════════════════════════
// ANTHROPIC CLIENT — con validación
// ═══════════════════════════════════════════════════════════

const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("❌ FATAL: ANTHROPIC_API_KEY no está configurada.");
  console.error("   → En Render: Dashboard > tu servicio > Environment > Add Variable");
  console.error("   → Key: ANTHROPIC_API_KEY  Value: sk-ant-...");
  // No hacemos process.exit() para que Render pueda mostrar los logs
}

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

// Helper: llamar a Claude con timeout y manejo de errores
async function askClaude(prompt, maxTokens = 1500) {
  if (!anthropic) {
    throw new Error("API key no configurada. Revisa las variables de entorno en Render.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000); // 55s (Render corta a 60s)

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.find((b) => b.type === "text")?.text || "";
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Helper: extraer JSON de la respuesta de Claude
function extractJSON(text, type = "object") {
  const pattern = type === "array" ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = text.match(pattern);
  if (!match) throw new Error("Claude no devolvió JSON válido");
  return JSON.parse(match[0]);
}

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK — Render necesita esto
// ═══════════════════════════════════════════════════════════

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "grant-pipeline-v2",
    apiConfigured: !!API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════
// 🔍 SCOUT AGENT — Busca grants relevantes
// ═══════════════════════════════════════════════════════════

app.post("/api/scout", async (req, res) => {
  const startTime = Date.now();
  console.log("📡 POST /api/scout recibido");

  try {
    const { niche, countries, orgType, foundation } = req.body;

    // Validación: necesitamos al menos un criterio de búsqueda
    if (!niche && !countries && !foundation) {
      return res.status(400).json({
        success: false,
        error: "Se requiere al menos: niche, countries, o foundation",
      });
    }

    const prompt = `Actúa como un analista experto en captación de subvenciones internacionales con 10+ años de experiencia.

CRITERIOS DE BÚSQUEDA:
- Nicho/Área: ${niche || foundation?.areas || "educación, medio ambiente, desarrollo social"}
- Países/Región: ${countries || foundation?.country || "América Latina"}
- Tipo de organización: ${orgType || "ONGs sin fines de lucro"}
${foundation ? `
FUNDACIÓN APLICANTE:
- Nombre: ${foundation.name}
- País: ${foundation.country}
- Áreas: ${foundation.areas}
- Misión: ${foundation.mission}` : ""}

TAREA: Genera una lista de 4-6 grants/subvenciones REALES que podrían estar abiertas o abrirse próximamente para estos criterios.

Incluye grants de fuentes como:
- Fundaciones internacionales (Ford, Gates, MacArthur, Open Society, Kellogg, etc.)
- Agencias de cooperación (USAID, UE, BID, CAF, GIZ, AECID, JICA)
- Organismos multilaterales (ONU, UNESCO, PNUD, FAO)
- Programas gubernamentales de cooperación
- Fondos temáticos especializados

Devuelve ÚNICAMENTE un JSON array válido con esta estructura exacta:
[
  {
    "name": "Nombre específico del programa/convocatoria",
    "donor": "Organización donante",
    "amount": "Rango de montos (ej: $10,000 - $50,000 USD)",
    "deadline": "Fecha estimada o 'Rolling' o 'Verificar en sitio web'",
    "region": "Regiones/países elegibles",
    "requirements": "Requisitos principales resumidos en 2-3 líneas",
    "url": "URL del sitio web del donante (la más específica posible)",
    "observations": "Consejo estratégico para el aplicante",
    "source": "Tipo de fuente (fundación privada, agencia bilateral, multilateral, etc.)"
  }
]

IMPORTANTE:
- Usa URLs reales de organizaciones que existen
- Los montos deben ser realistas para el tipo de donante
- Los requisitos deben ser específicos, no genéricos
- Las observaciones deben dar valor estratégico real
- Devuelve SOLO el JSON array, sin texto adicional`;

    console.log("🤖 Llamando a Claude para Scout...");
    const text = await askClaude(prompt, 2500);
    const grants = extractJSON(text, "array");

    console.log(`✅ Scout completado: ${grants.length} grants en ${Date.now() - startTime}ms`);
    res.json({ success: true, grants });
  } catch (err) {
    console.error("❌ Scout error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 🧠 ANALYZER AGENT — Evalúa compatibilidad
// ═══════════════════════════════════════════════════════════

app.post("/api/analyze", async (req, res) => {
  const startTime = Date.now();
  console.log("📡 POST /api/analyze recibido");

  try {
    const { foundation, grant } = req.body;

    if (!foundation || !grant) {
      return res.status(400).json({
        success: false,
        error: "Se requiere 'foundation' y 'grant' en el body",
      });
    }

    const prompt = `Actúa como consultor senior especializado en grants internacionales con 15+ años de experiencia evaluando aplicaciones.

Evalúa la compatibilidad entre esta fundación y este grant:

FUNDACIÓN APLICANTE:
- Nombre: ${foundation.name}
- País: ${foundation.country}
- Áreas de impacto: ${foundation.areas}
- Misión: ${foundation.mission}
${foundation.budget ? `- Presupuesto anual: ${foundation.budget}` : ""}
${foundation.teamSize ? `- Tamaño del equipo: ${foundation.teamSize}` : ""}

GRANT/CONVOCATORIA:
- Nombre: ${grant.name}
- Donante: ${grant.donor}
- Monto: ${grant.amount}
- Región elegible: ${grant.region}
- Deadline: ${grant.deadline || "No especificado"}
- Requisitos: ${grant.requirements || "No especificados"}
${grant.url ? `- URL: ${grant.url}` : ""}

Analiza:
1. Alineación temática (¿las áreas de la fundación coinciden con lo que financia el grant?)
2. Elegibilidad geográfica (¿el país de la fundación está en la región elegible?)
3. Capacidad institucional (¿la fundación puede ejecutar un proyecto de este monto?)
4. Fortalezas competitivas (¿qué hace destacar a esta fundación?)
5. Riesgos y brechas (¿qué falta o podría ser problemático?)

Devuelve ÚNICAMENTE un JSON válido con esta estructura exacta:
{
  "score": 78,
  "recommendation": "Aplicar",
  "justification": "Explicación clara de 2-3 oraciones sobre la compatibilidad general",
  "strengths": ["Fortaleza específica 1", "Fortaleza específica 2", "Fortaleza específica 3"],
  "risks": ["Riesgo o brecha 1", "Riesgo o brecha 2"],
  "nextSteps": ["Acción concreta 1", "Acción concreta 2", "Acción concreta 3"],
  "timeline": "Tiempo estimado para preparar una aplicación competitiva"
}

REGLAS:
- Score: 0-100 (0=incompatible, 50=parcial, 75+=buena candidata, 90+=excelente match)
- Recommendation: "Aplicar", "Revisar con cautela", o "No aplicar"
- Sé honesto y específico, no genérico
- Solo JSON, sin texto adicional`;

    console.log("🤖 Llamando a Claude para Analyzer...");
    const text = await askClaude(prompt, 1500);
    const analysis = extractJSON(text, "object");

    // Asegurar que los arrays sean arrays
    if (typeof analysis.strengths === "string") analysis.strengths = [analysis.strengths];
    if (typeof analysis.risks === "string") analysis.risks = [analysis.risks];
    if (typeof analysis.nextSteps === "string") analysis.nextSteps = [analysis.nextSteps];

    console.log(`✅ Análisis completado: Score ${analysis.score}% en ${Date.now() - startTime}ms`);
    res.json({ success: true, analysis });
  } catch (err) {
    console.error("❌ Analyze error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 📝 GENERATOR AGENT — Crea propuesta completa
// ═══════════════════════════════════════════════════════════

app.post("/api/generate", async (req, res) => {
  const startTime = Date.now();
  console.log("📡 POST /api/generate recibido");

  try {
    const { foundation, grant, analysis } = req.body;

    if (!foundation || !grant) {
      return res.status(400).json({
        success: false,
        error: "Se requiere 'foundation' y 'grant' en el body",
      });
    }

    const prompt = `Actúa como un redactor profesional de propuestas de grants con amplia experiencia en financiamiento internacional y cooperación para el desarrollo.

Genera una propuesta COMPLETA Y PROFESIONAL para esta aplicación:

FUNDACIÓN APLICANTE:
- Nombre: ${foundation.name}
- País: ${foundation.country}
- Áreas de impacto: ${foundation.areas}
- Misión: ${foundation.mission}
${foundation.budget ? `- Presupuesto anual: ${foundation.budget}` : ""}

GRANT OBJETIVO:
- Nombre: ${grant.name}
- Donante: ${grant.donor}
- Monto disponible: ${grant.amount}
- Región elegible: ${grant.region}
- Requisitos: ${grant.requirements || "Generales del sector"}
${analysis ? `
ANÁLISIS PREVIO DE COMPATIBILIDAD:
- Score: ${analysis.score}%
- Recomendación: ${analysis.recommendation}
- Fortalezas identificadas: ${JSON.stringify(analysis.strengths)}
- Riesgos: ${JSON.stringify(analysis.risks)}` : ""}

GENERA LA PROPUESTA CON ESTAS SECCIONES:

# PROPUESTA DE PROYECTO: [Título creativo y relevante]

## 1. RESUMEN EJECUTIVO
(2-3 párrafos concisos que capturen la esencia del proyecto, el problema que aborda, la solución propuesta y el impacto esperado)

## 2. JUSTIFICACIÓN Y CONTEXTO
(Problemática documentada con datos, contexto regional, necesidad identificada, por qué es urgente actuar)

## 3. OBJETIVOS
### Objetivo General
### Objetivos Específicos (3-5, formato SMART)

## 4. METODOLOGÍA Y PLAN DE ACTIVIDADES
(Enfoque metodológico, fases de implementación, actividades clave por fase, actores involucrados)

## 5. RESULTADOS ESPERADOS E INDICADORES DE IMPACTO
(Métricas concretas y verificables, medios de verificación)

## 6. PRESUPUESTO ESTIMADO
(Tabla con categorías: personal, actividades, equipamiento, administración, imprevistos)

## 7. CRONOGRAMA
(Fases con timeline realista)

## 8. SOSTENIBILIDAD
(Plan post-financiamiento, estrategia de continuidad, apropiación local)

## 9. EQUIPO Y CAPACIDAD INSTITUCIONAL
(Experiencia relevante de la organización, equipo clave)

## 10. ALINEACIÓN CON EL DONANTE
(Cómo el proyecto se alinea con las prioridades y valores del donante)

INSTRUCCIONES:
- Escribe en español profesional pero accesible
- Extensión: 1200-1800 palabras
- Sé específico y concreto, no genérico
- Incluye datos y cifras realistas
- El presupuesto debe sumar dentro del rango del grant
- Adapta el tono al tipo de donante`;

    console.log("🤖 Llamando a Claude para Generator...");
    const text = await askClaude(prompt, 3500);

    console.log(`✅ Propuesta generada: ${text.length} caracteres en ${Date.now() - startTime}ms`);
    res.json({ success: true, proposal: text });
  } catch (err) {
    console.error("❌ Generate error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 🧪 TEST ENDPOINT — Para verificar que todo funciona
// ═══════════════════════════════════════════════════════════

app.get("/api/test", async (req, res) => {
  console.log("📡 GET /api/test");

  const checks = {
    server: "✅ OK",
    apiKey: API_KEY ? "✅ Configurada" : "❌ No configurada",
    anthropic: anthropic ? "✅ Cliente creado" : "❌ No disponible",
    apiCall: "⏳ Probando...",
  };

  if (anthropic) {
    try {
      const text = await askClaude("Responde solo: OK", 50);
      checks.apiCall = text.includes("OK") ? "✅ Funcionando" : `⚠️ Respuesta: ${text.substring(0, 50)}`;
    } catch (err) {
      checks.apiCall = `❌ Error: ${err.message}`;
    }
  } else {
    checks.apiCall = "❌ No se puede probar sin API key";
  }

  res.json(checks);
});

// ═══════════════════════════════════════════════════════════
// FRONTEND — Sirve index.html
// ═══════════════════════════════════════════════════════════

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🚀 Grant Pipeline v2 corriendo en puerto ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Test:   http://localhost:${PORT}/api/test`);
  console.log(`   API Key: ${API_KEY ? "✅ Configurada" : "❌ FALTA — configura ANTHROPIC_API_KEY"}\n`);
});
