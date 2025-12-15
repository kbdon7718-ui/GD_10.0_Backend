import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ======================================================
   DASHBOARD OVERVIEW
====================================================== */
router.get("/overview", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        success: false,
        error: "company_id and godown_id required",
      });
    }

    const today = date || new Date().toISOString().split("T")[0];
    const monthStart = today.slice(0, 7) + "-01";

    /* ===========================
       SCRAP IN (DAILY)
    =========================== */
    const scrapInDailyRes = await pool.query(
      `
      SELECT COALESCE(SUM(i.weight),0) AS total
      FROM maal_in m
      JOIN maal_in_items i ON i.maal_in_id = m.id
      WHERE m.company_id=$1
        AND m.godown_id=$2
        AND m.date=$3
      `,
      [company_id, godown_id, today]
    );

    /* ===========================
       SCRAP IN (MONTHLY)
    =========================== */
    const scrapInMonthlyRes = await pool.query(
      `
      SELECT COALESCE(SUM(i.weight),0) AS total
      FROM maal_in m
      JOIN maal_in_items i ON i.maal_in_id = m.id
      WHERE m.company_id=$1
        AND m.godown_id=$2
        AND m.date BETWEEN $3 AND $4
      `,
      [company_id, godown_id, monthStart, today]
    );

    /* ===========================
       SCRAP OUT (DAILY ONLY)
    =========================== */
    const scrapOutDailyRes = await pool.query(
      `
      SELECT COALESCE(SUM(weight),0) AS total
      FROM maal_out_items oi
      JOIN maal_out o ON o.id = oi.maal_out_id
      WHERE o.company_id=$1
        AND o.godown_id=$2
        AND o.date=$3
      `,
      [company_id, godown_id, today]
    );

    /* ===========================
       CASH (ROKADI)
    =========================== */
    const cashRes = await pool.query(
      `
      SELECT COALESCE(SUM(balance),0) AS total
      FROM rokadi_accounts
      WHERE company_id=$1 AND godown_id=$2
      `,
      [company_id, godown_id]
    );

    /* ===========================
       BANK BALANCE
    =========================== */
    const bankRes = await pool.query(
      `
      SELECT COALESCE(SUM(current_balance),0) AS total
      FROM bank_accounts
      WHERE company_id=$1 AND godown_id=$2
      `,
      [company_id, godown_id]
    );

    return res.json({
      success: true,
      date: today,
      scrap_in: {
        daily: Number(scrapInDailyRes.rows[0].total),
        monthly: Number(scrapInMonthlyRes.rows[0].total),
      },
      scrap_out: {
        daily: Number(scrapOutDailyRes.rows[0].total),
      },
      finance: {
        cash_in_hand: Number(cashRes.rows[0].total),
        bank_balance: Number(bankRes.rows[0].total),
      },
    });

  } catch (err) {
    console.error("❌ Dashboard Overview Error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export default router;
