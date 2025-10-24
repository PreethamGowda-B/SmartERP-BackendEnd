require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { pool } = require('../db'); // ✅ Correct import
const jobsRouter = require("./routes/jobs");
const usersRouter = require("./routes/users");
const attendanceRouter = require("./routes/attendance");
const expensesRouter = require("./routes/expenses");
const payrollRouter = require("./routes/payroll");
const materialRequestsRouter = require("./routes/materialRequests");
const shiftsRouter = require("./routes/shifts");
const authRouter = require("./routes/auth");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || "*",
  credentials: true,
}));

app.use(bodyParser.json());
app.use(express.json());

// ✅ Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "🚀 SmartERP Backend API is running successfully!",
    environment: process.env.NODE_ENV,
  });
});

// ✅ Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      database: "connected",
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error("❌ Health check DB error:", err.message);
    res.status(500).json({
      status: "error",
      database: "unreachable",
      error: err.message,
    });
  }
});

// ✅ All API routes
app.use("/auth", authRouter);
app.use("/jobs", jobsRouter);
app.use("/users", usersRouter);
app.use("/attendance", attendanceRouter);
app.use("/expenses", expensesRouter);
app.use("/payroll", payrollRouter);
app.use("/materials", materialRequestsRouter);
app.use("/shifts", shiftsRouter);

// ✅ Default 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// ✅ Start the server
app.listen(PORT, () => {
  console.log(`🚀 SmartERP backend running on port ${PORT}`);
});

// ✅ Test DB connection at startup
(async function testConnection() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("✅ Connected to PostgreSQL (Render Cloud)");
    console.log("🕒 Current time:", result.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
  }
})();
