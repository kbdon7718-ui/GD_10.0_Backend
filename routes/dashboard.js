import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/**
 * 📊 DASHBOARD OVERVIEW
 */
router.get("/overview", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        success: false,
        error: "company_id and godown_id required",
      });
    }

    /* =========================
       SCRAP IN (Today & Month)
    ========================= */
    const scrapInResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(weight),0) FILTER (WHERE date::date = CURRENT_DATE) AS today,
        COALESCE(SUM(weight),0)
          FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)) AS month
      FROM maal_in
      WHERE company_id = $1 AND godown_id = $2
      `,
      [company_id, godown_id]
    );

    /* =========================
       SCRAP OUT (Today)
    ========================= */
    const scrapOutResult = await pool.query(
      `
      SELECT COALESCE(SUM(weight),0) AS today
      FROM maal_out
      WHERE company_id = $1
        AND godown_id = $2
        AND date::date = CURRENT_DATE
      `,
      [company_id, godown_id]
    );

    /* =========================
       CASH & BANK (ROKADI)
    ========================= */
    const cashResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(balance),0) FILTER (WHERE account_type = 'cash') AS cash,
        COALESCE(SUM(balance),0) FILTER (WHERE account_type = 'bank') AS bank
      FROM rokadi_accounts
      WHERE company_id = $1 AND godown_id = $2
      `,
      [company_id, godown_id]
    );

    /* =========================
       SCRAP BY MATERIAL (Today)
    ========================= */
    const scrapByMaterialResult = await pool.query(
      `
      SELECT material, COALESCE(SUM(weight),0) AS weight
      FROM maal_in
      WHERE company_id = $1
        AND godown_id = $2
        AND date::date = CURRENT_DATE
      GROUP BY material
      ORDER BY material
      `,
      [company_id, godown_id]
    );

    /* =========================
       💰 EXPENSE ANALYTICS (MONTH)
       PhonePe-style summary
    ========================= */
    const expenseSummaryResult = await pool.query(
      `
      SELECT
        category,
        COUNT(*) AS payments,
        COALESCE(SUM(amount),0) AS total
      FROM expenses
      WHERE company_id = $1
        AND godown_id = $2
        AND date >= date_trunc('month', CURRENT_DATE)
      GROUP BY category
      ORDER BY total DESC
      `,
      [company_id, godown_id]
    );

    /* =========================
       FINAL RESPONSE
    ========================= */
    res.json({
      success: true,

      scrap_in: {
        nd: Number(scrapInResult.rows[0].today),
        mo: Number(scrapInResult.rows[0].month),
      },

      scrap_out: {
        nd: Number(scrapOutResult.rows[0].today),
      },

      cash: {
        rokadi: Number(cashResult.rows[0].cash),
        bank: Number(cashResult.rows[0].bank),
      },

      scrap_by_material: scrapByMaterialResult.rows,

      // ✅ NEW — SAFE FOR FRONTEND
      expense_summary: expenseSummaryResult.rows.map((r) => ({
        category: r.category,
        payments: Number(r.payments),
        total: Number(r.total),
      })),
    });
  } catch (err) {
    console.error("❌ DASHBOARD ERROR:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export default router;
