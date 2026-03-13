const express = require("express");
const router = express.Router();

const { chatWithAI } = require("../services/ai.service");
const { authenticateToken } = require("../middleware/authMiddleware");
const { loadPlan } = require("../middleware/planMiddleware");
const { requireFeature } = require("../middleware/featureGuard");

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
// Gated: Pro plan only (ai_assistant feature)
router.post(
  "/chat",
  authenticateToken,
  loadPlan,
  requireFeature("ai_assistant"),
  async (req, res) => {
    try {
      const { message } = req.body;

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      const reply = await chatWithAI(message);
      res.json({ reply });
    } catch (error) {
      console.error("AI error:", error);
      res.status(500).json({ error: "AI Assistant is temporarily unavailable. Please try again in a few moments." });
    }
  }
);

module.exports = router;
