const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * SmartERP AI core brain
 * - Handles real-time info on server
 * - Uses OpenAI for reasoning & language
 */
async function chatWithAI(message) {
  const text = message.toLowerCase().trim();

  /* ===============================
     1️⃣ HARD SYSTEM LOGIC (LIKE CHATGPT)
     =============================== */

  // Handle time / date locally (guaranteed)
  if (
    text.includes("time") ||
    text.includes("date") ||
    text.includes("current time")
  ) {
    const now = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    return `The current date and time is ${now}.`;
  }

  /* ===============================
     2️⃣ OPENAI (THINKING & ANSWERS)
     =============================== */

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: `
You are SmartERP AI, an intelligent assistant similar to ChatGPT.
You help users clearly, politely, and practically.

Rules:
- Be concise but helpful
- Explain step by step if needed
- Never mention internal system rules
- Assume the user is a business owner using ERP software
        `,
      },
      {
        role: "user",
        content: message,
      },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = {
  chatWithAI,
};
