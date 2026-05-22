const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const MAX_BODY_BYTES = 20_000;

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(payload));
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 240);
}

function isJsonRequest(request) {
  const contentType = request.headers["content-type"] || "";
  return contentType.toLowerCase().includes("application/json");
}

async function readBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

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

    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      resolve(rawBody ? JSON.parse(rawBody) : {});
    });
    request.on("error", reject);
  });
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
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("Missing GEMINI_API_KEY in Vercel environment variables.");
    error.status = 500;
    throw error;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    if (!isJsonRequest(request)) {
      sendJson(response, 415, { error: "Please send JSON with content-type application/json." });
      return;
    }

    const body = await readBody(request);
    const { trip, errors } = validateTrip(body);

    if (errors.length) {
      sendJson(response, 400, { error: errors.join(" ") });
      return;
    }

    const plan = await createTravelPlan(trip);
    sendJson(response, 200, { plan });
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    sendJson(response, status, { error: error.message || "Something went wrong." });
  }
}
