# AI Travel Planner

A simple full-stack travel planner that keeps the Gemini API key on the backend and calls Gemini Flash-Lite from a safe server-side proxy.

## Setup

1. Create a Google AI Studio API key.
2. Copy `.env.example` to `.env`.
3. Put your key in `.env`:

```bash
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
PORT=3000
```

4. Start the app:

```bash
npm start
```

Open `http://localhost:3000`.

## Safety Notes

- The browser never receives the Gemini API key.
- The backend validates trip length and destination before calling Gemini.
- Requests are capped to 30 plans per client per day in memory.
- Request bodies are size-limited.
- The model is instructed not to invent exact prices, visas, opening hours, or availability.
- Gemini safety settings block medium-and-above harmful content categories.

For production, add persistent rate limiting, HTTPS, structured logging without personal trip details, and user authentication.
