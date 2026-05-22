import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

function loadLocalEnv() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) continue;

    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const MAX_BODY_BYTES = 20_000;
const DAILY_LIMIT = 30;
const WINDOW_MS = 24 * 60 * 60 * 1000;

const rateBuckets = new Map();
const publicRoot = resolve(publicDir);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  response.end(JSON.stringify(payload));
}

function clientId(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  return Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : (forwardedFor || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkRateLimit(id) {
  const now = Date.now();
  const bucket = rateBuckets.get(id);

  if (!bucket || now - bucket.startedAt > WINDOW_MS) {
    rateBuckets.set(id, { count: 1, startedAt: now });
    return true;
  }

  if (bucket.count >= DAILY_LIMIT) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 240);
}

function isJsonRequest(request) {
  const contentType = request.headers["content-type"] || "";
  return contentType.toLowerCase().includes("application/json");
}

function validateTrip(input) {
  const trip = {
    destination: cleanText(input.destination),
    origin: cleanText(input.origin, "Not specified"),
    days: Number(input.days),
    budget: cleanText(input.budget, "mid-range"),
    travelers: cleanText(input.travelers, "2 adults"),
    style: cleanText(input.style, "balanced"),
    interests: cleanText(input.interests, "local food, landmarks, relaxed exploring"),
    pace: cleanText(input.pace, "balanced"),
    notes: cleanText(input.notes)
  };

  const errors = [];
  if (trip.destination.length < 2) errors.push("Destination is required.");
  if (!Number.isInteger(trip.days) || trip.days < 1 || trip.days > 21) {
    errors.push("Trip length must be between 1 and 21 days.");
  }

  return { trip, errors };
}

function buildPrompt(trip) {
  return `Create a practical travel plan as strict JSON only.

Requirements:
- Destination: ${trip.destination}
- Starting location: ${trip.origin}
- Trip length: ${trip.days} days
- Budget: ${trip.budget}
- Travelers: ${trip.travelers}
- Travel style: ${trip.style}
- Pace: ${trip.pace}
- Interests: ${trip.interests}
- Extra notes: ${trip.notes || "None"}

Safety and quality rules:
- Do not invent exact prices, booking availability, opening hours, or visa rules.
- Mark time-sensitive details as "check before booking".
- Avoid unsafe activities and include sensible local safety notes.
- Keep the plan family-friendly unless the user explicitly asked otherwise.
- Return JSON only, with this shape:
{
  "summary": "short overview",
  "bestTimeToGo": "short practical note",
  "dailyPlan": [
    {
      "day": 1,
      "theme": "day theme",
      "morning": "activity",
      "afternoon": "activity",
      "evening": "activity",
      "foodSuggestion": "local food idea",
      "safetyNote": "brief safety note"
    }
  ],
  "packingList": ["item"],
  "budgetTips": ["tip"],
  "bookingChecklist": ["item to verify"]
}`;
}

const planSchema = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    bestTimeToGo: { type: "STRING" },
    dailyPlan: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          day: { type: "INTEGER" },
          theme: { type: "STRING" },
          morning: { type: "STRING" },
          afternoon: { type: "STRING" },
          evening: { type: "STRING" },
          foodSuggestion: { type: "STRING" },
          safetyNote: { type: "STRING" }
        },
        required: ["day", "theme", "morning", "afternoon", "evening", "foodSuggestion", "safetyNote"]
      }
    },
    packingList: { type: "ARRAY", items: { type: "STRING" } },
    budgetTips: { type: "ARRAY", items: { type: "STRING" } },
    bookingChecklist: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["summary", "bestTimeToGo", "dailyPlan", "packingList", "budgetTips", "bookingChecklist"]
};

function parseGeminiJson(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

async function createTravelPlan(trip) {
  if (!GEMINI_API_KEY) {
    const error = new Error("Missing GEMINI_API_KEY. Add it to your environment or .env file.");
    error.status = 500;
    throw error;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const geminiResponse = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(trip) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: planSchema,
        temperature: 0.5,
        maxOutputTokens: 4096
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
      ]
    })
  });

  const data = await geminiResponse.json().catch(() => ({}));

  if (!geminiResponse.ok) {
    const message = data?.error?.message || "Gemini request failed.";
    const error = new Error(message);
    error.status = geminiResponse.status;
    throw error;
  }

  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) {
    const error = new Error("Gemini returned an empty plan. Try a more specific destination.");
    error.status = 502;
    throw error;
  }

  return parseGeminiJson(text);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = normalize(requestedPath).replace(/^([/\\])+/, "").replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(publicDir, safePath);
  const staticRelativePath = relative(publicRoot, filePath);

  if (staticRelativePath.startsWith("..") || resolve(staticRelativePath) === staticRelativePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "POST" && url.pathname === "/api/plan") {
      if (!isJsonRequest(request)) {
        sendJson(response, 415, { error: "Please send JSON with content-type application/json." });
        return;
      }

      const rawBody = await readBody(request);
      const body = JSON.parse(rawBody || "{}");
      const { trip, errors } = validateTrip(body);

      if (errors.length) {
        sendJson(response, 400, { error: errors.join(" ") });
        return;
      }

      if (!checkRateLimit(clientId(request))) {
        sendJson(response, 429, { error: "Daily planning limit reached. Please try again tomorrow." });
        return;
      }

      const plan = await createTravelPlan(trip);
      sendJson(response, 200, { plan });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(request, response);
      return;
    }

    response.writeHead(405);
    response.end("Method not allowed");
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    sendJson(response, status, { error: error.message || "Something went wrong." });
  }
});

server.listen(PORT, () => {
  console.log(`AI Travel Planner running at http://localhost:${PORT}`);
});
