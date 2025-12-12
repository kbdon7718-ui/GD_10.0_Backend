// backend/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// ✅ Import route files
import expenseRoutes from "./routes/expenses.js";
import labourRoutes from "./routes/labour.js";
import kabadiwalaRoutes from "./routes/kabadiwala.js";
import feriwalaRoutes from "./routes/feriwala.js";
import maalOutRoutes from "./routes/maalOut.js";
import maalinRoutes from "./routes/maalIn.js";
import truckRoutes from "./routes/truck.js";
import ratesRoutes from "./routes/rates.js";
// DB Connection
import { pool } from "./config/db.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🟢 Root Test
app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.send(
      `✅ ScrapCo Backend API connected to Supabase! Time: ${result.rows[0].now}`
    );
  } catch (err) {
    console.error("❌ Database connection error:", err.message);
    res.status(500).send("Database connection failed: " + err.message);
  }
});

// 🟢 Register Routes
app.use("/api/expenses", expenseRoutes);
app.use("/api/labour", labourRoutes);
app.use("/api/kabadiwala", kabadiwalaRoutes);
app.use("/api/feriwala", feriwalaRoutes);
app.use("/api/maalout", maalOutRoutes);
app.use("/api/maalin", maalinRoutes);
app.use("/api/truck", truckRoutes);
app.use("/api/rates", ratesRoutes);

// 🟠 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// 🟢 Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 ScrapCo Backend running on port ${PORT}`));
