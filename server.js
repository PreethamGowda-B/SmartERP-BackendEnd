require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { pool } = require("./db");

const app = express();

// ✅ CORS Configuration (VERY IMPORTANT)
app.use(
  cors({
    origin: [
      "http://localhost:3000", // local dev
      "https://smart-erp-front-end.vercel.app", // live frontend
    ],
    credentials: true, // allow sending cookies
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(express.json());
app.use(cookieParser());

// ✅ ROUTES
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

// (Optional: add other routes later)
app.get("/api/health", async (req, res) => {
  try {
    const dbRes = await pool.query("SELECT NOW()");
    res.json({ status: "ok", time: dbRes.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ✅ Root test route
app.get("/", (req, res) => {
  res.json({
    message: "🚀 SmartERP Backend API is running successfully!",
    frontend: "https://smart-erp-front-end.vercel.app",
  });
});

// ✅ Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SmartERP backend running on port ${PORT}`));
