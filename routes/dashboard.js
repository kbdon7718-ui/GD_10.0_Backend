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

    // Helper for default empty
    const safe = (v, d = 0) => (v === null || v === undefined ? d : v);

    // SCRAP IN
    const scrapIn = await pool.query(
      `SELECT
        COALESCE(SUM(NULLIF(mii.weight::text,'')::numeric) FILTER (WHERE mi.date::date = CURRENT_DATE),0) AS today,
        COALESCE(SUM(NULLIF(mii.weight::text,'')::numeric) FILTER (WHERE mi.date >= date_trunc('month', CURRENT_DATE)),0) AS month,
        COALESCE(SUM(NULLIF(mii.weight::text,'')::numeric),0) AS all_time
      FROM maal_in_items mii
      JOIN maal_in mi ON mi.id = mii.maal_in_id
      WHERE mi.company_id = $1 AND mi.godown_id = $2`,
      [company_id, godown_id]
    );

    // SCRAP OUT
    const scrapOut = await pool.query(
      `SELECT
        COALESCE(SUM(NULLIF(weight::text,'')::numeric) FILTER (WHERE date::date = CURRENT_DATE),0) AS today,
        COALESCE(SUM(NULLIF(weight::text,'')::numeric) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)),0) AS month,
        COALESCE(SUM(NULLIF(weight::text,'')::numeric),0) AS all_time
      FROM maal_out WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // EXPENSES
    const expenses = await pool.query(
      `SELECT
        COALESCE(SUM(NULLIF(amount::text,'')::numeric) FILTER (WHERE date::date = CURRENT_DATE),0) AS today,
        COALESCE(SUM(NULLIF(amount::text,'')::numeric) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)),0) AS month,
        COALESCE(SUM(NULLIF(amount::text,'')::numeric),0) AS all_time
      FROM expenses WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // TRUCK
    const truck = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE date::date = CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)) AS month,
        COUNT(*) AS all_time
      FROM truck_transactions WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // FERIWALA
    const feriwala = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE date::date = CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)) AS month,
        COUNT(*) AS all_time
      FROM feriwala_records WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // KABADIWALA
    const kabadiwala = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE date::date = CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE date >= date_trunc('month', CURRENT_DATE)) AS month,
        COUNT(*) AS all_time
      FROM kabadiwala_records WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // LABOUR
    const labour = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) AS month,
        COUNT(*) AS all_time
      FROM labour WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // CASH & BANK (ROKADI)
    const cashResult = await pool.query(
      `SELECT
        COALESCE(SUM(NULLIF(balance::text,'')::numeric) FILTER (WHERE account_type = 'cash'),0) AS cash,
        COALESCE(SUM(NULLIF(balance::text,'')::numeric) FILTER (WHERE account_type = 'bank'),0) AS bank
      FROM rokadi_accounts WHERE company_id = $1 AND godown_id = $2`,
      [company_id, godown_id]
    );

    // SCRAP BY MATERIAL (Today)
    const scrapByMaterialResult = await pool.query(
      `SELECT mii.material, COALESCE(SUM(NULLIF(mii.weight::text,'')::numeric),0) AS weight
      FROM maal_in_items mii
      JOIN maal_in mi ON mi.id = mii.maal_in_id
      WHERE mi.company_id = $1 AND mi.godown_id = $2 AND mi.date::date = CURRENT_DATE
      GROUP BY mii.material ORDER BY mii.material`,
      [company_id, godown_id]
    );

    // EXPENSE ANALYTICS (MONTH)
    const expenseSummaryResult = await pool.query(
      `SELECT category, COUNT(*) AS payments, COALESCE(SUM(NULLIF(amount::text,'')::numeric),0) AS total
      FROM expenses WHERE company_id = $1 AND godown_id = $2 AND date >= date_trunc('month', CURRENT_DATE)
      GROUP BY category ORDER BY total DESC`,
      [company_id, godown_id]
    );

    res.json({
      success: true,
      analytics: {
        scrap_in: {
          today: safe(scrapIn.rows[0]?.today),
          month: safe(scrapIn.rows[0]?.month),
          all_time: safe(scrapIn.rows[0]?.all_time),
        },
        scrap_out: {
          today: safe(scrapOut.rows[0]?.today),
          month: safe(scrapOut.rows[0]?.month),
          all_time: safe(scrapOut.rows[0]?.all_time),
        },
        expenses: {
          today: safe(expenses.rows[0]?.today),
          month: safe(expenses.rows[0]?.month),
          all_time: safe(expenses.rows[0]?.all_time),
        },
        truck: {
          today: safe(truck.rows[0]?.today),
          month: safe(truck.rows[0]?.month),
          all_time: safe(truck.rows[0]?.all_time),
        },
        feriwala: {
          today: safe(feriwala.rows[0]?.today),
          month: safe(feriwala.rows[0]?.month),
          all_time: safe(feriwala.rows[0]?.all_time),
        },
        kabadiwala: {
          today: safe(kabadiwala.rows[0]?.today),
          month: safe(kabadiwala.rows[0]?.month),
          all_time: safe(kabadiwala.rows[0]?.all_time),
        },
        labour: {
          today: safe(labour.rows[0]?.today),
          month: safe(labour.rows[0]?.month),
          all_time: safe(labour.rows[0]?.all_time),
        },
        cash: {
          rokadi: safe(cashResult.rows[0]?.cash),
          bank: safe(cashResult.rows[0]?.bank),
        },
        scrap_by_material: scrapByMaterialResult.rows || [],
        expense_summary: expenseSummaryResult.rows.map((r) => ({
          category: r.category,
          payments: Number(r.payments),
          total: Number(r.total),
        })),
      },
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
