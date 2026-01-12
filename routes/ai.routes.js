const express = require("express");
const router = express.Router();

const { chatWithAI } = require("../services/ai.service");

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const reply = await chatWithAI(message);

    res.json({ reply });
  } catch (error) {
    console.error("AI error:", error);
    res.status(500).json({ error: "AI processing failed" });
  }
});

module.exports = router;
