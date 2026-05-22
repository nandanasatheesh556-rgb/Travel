const form = document.querySelector("#planner-form");
const submitButton = document.querySelector("#submit-button");
const submitButtonText = submitButton.querySelector("span");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const planOutput = document.querySelector("#plan-output");

function setView(view) {
  emptyState.classList.toggle("hidden", view !== "empty");
  loadingState.classList.toggle("hidden", view !== "loading");
  errorState.classList.toggle("hidden", view !== "error");
  planOutput.classList.toggle("hidden", view !== "plan");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function listItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
}

function renderSlot(label, value) {
  return `
    <div class="slot">
      <strong>${label}</strong>
      <span>${escapeHtml(value || "Check before booking.")}</span>
    </div>
  `;
}

function renderPlan(plan) {
  const days = Array.isArray(plan.dailyPlan) ? plan.dailyPlan : [];
  planOutput.innerHTML = `
    <header class="plan-header">
      <h2>Your trip plan</h2>
      <p>${escapeHtml(plan.summary)}</p>
      <p><strong>Best time to go:</strong> ${escapeHtml(plan.bestTimeToGo)}</p>
    </header>

    <section class="day-grid">
      ${days.map((day) => `
        <article class="day-card">
          <h3>Day ${escapeHtml(day.day)}: ${escapeHtml(day.theme)}</h3>
          ${renderSlot("Morning", day.morning)}
          ${renderSlot("Afternoon", day.afternoon)}
          ${renderSlot("Evening", day.evening)}
          ${renderSlot("Food", day.foodSuggestion)}
          ${renderSlot("Safety", day.safetyNote)}
        </article>
      `).join("")}
    </section>

    <section class="list-section">
      <h3>Packing list</h3>
      <ul class="chip-list">${listItems(plan.packingList)}</ul>
    </section>

    <section class="list-section">
      <h3>Budget tips</h3>
      <ul class="chip-list">${listItems(plan.budgetTips)}</ul>
    </section>

    <section class="list-section">
      <h3>Booking checklist</h3>
      <ul class="chip-list">${listItems(plan.bookingChecklist)}</ul>
    </section>
  `;
}

async function readApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return {
    error: text.trim() || "The server returned an unexpected response."
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setView("loading");
  submitButton.disabled = true;
  submitButtonText.textContent = "Generating...";

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.days = Number(payload.days);

  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await readApiResponse(response);
    if (!response.ok) {
      throw new Error(data.error || "Could not create the plan.");
    }

    renderPlan(data.plan);
    setView("plan");
  } catch (error) {
    errorState.textContent = error.message;
    setView("error");
  } finally {
    submitButton.disabled = false;
    submitButtonText.textContent = "Generate plan";
  }
});
