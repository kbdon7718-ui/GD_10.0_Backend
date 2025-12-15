import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* =========================================================
   MANAGER — SINGLE ENTRY POINT FOR ALL PAYMENTS
========================================================= */
router.post("/", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      company_id,
      godown_id,
      date,
      category,
      description,
      amount,
      payment_mode,
      paid_to,
    } = req.body;

    if (!company_id || !godown_id || !amount || !category) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    await client.query("BEGIN");

    /* ===============================
       NORMALIZE PAYMENT MODE
    =============================== */
    const pm = (payment_mode || "cash").toLowerCase(); // cash | upi | bank transfer
    const rokadiType = pm === "cash" ? "cash" : "bank";

    /* =====================================================
       1️⃣ FIND ROKADI ACCOUNT
    ===================================================== */
    const accRes = await client.query(
      `
      SELECT id
      FROM rokadi_accounts
      WHERE company_id=$1
        AND godown_id=$2
        AND account_type=$3
      LIMIT 1
      `,
      [company_id, godown_id, rokadiType]
    );

    if (accRes.rowCount === 0) {
      throw new Error(`Rokadi ${rokadiType} account not found`);
    }

    const account_id = accRes.rows[0].id;

    /* =====================================================
       2️⃣ SAVE EXPENSE (SOURCE OF TRUTH)
    ===================================================== */
    const expenseRes = await client.query(
      `
      INSERT INTO expenses
      (
        company_id,
        godown_id,
        date,
        category,
        description,
        amount,
        payment_mode,
        paid_to,
        account_id,
        created_at
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      RETURNING id;
      `,
      [
        company_id,
        godown_id,
        date || new Date(),
        category,
        description || "",
        amount,
        pm,
        paid_to || "",
        account_id,
      ]
    );

    const expense_id = expenseRes.rows[0].id;

    /* =====================================================
       3️⃣ ROKADI TRANSACTION (BALANCE AUTO VIA TRIGGER)
    ===================================================== */
    await client.query(
      `
      INSERT INTO rokadi_transactions
      (
        account_id,
        company_id,
        godown_id,
        type,
        amount,
        category,
        reference,
        created_at
      )
      VALUES
      ($1,$2,$3,'debit',$4,'expense',$5,NOW())
      `,
      [
        account_id,
        company_id,
        godown_id,
        amount,
        `${category}: ${paid_to || description}`,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      expense_id,
      message: "Expense recorded successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ EXPENSE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =====================================================
   LIST
===================================================== */
router.get("/list", async (req, res) => {
  const { company_id, godown_id, date } = req.query;

  const result = await pool.query(
    `
    SELECT *
    FROM expenses
    WHERE company_id=$1
      AND godown_id=$2
      AND ($3::date IS NULL OR date::date=$3::date)
    ORDER BY created_at DESC
    `,
    [company_id, godown_id, date || null]
  );

  res.json({ success: true, expenses: result.rows });
});

/* =====================================================
   SUMMARY
===================================================== */
router.get("/summary", async (req, res) => {
  const { company_id, godown_id, start_date, end_date } = req.query;

  const result = await pool.query(
    `
    SELECT
      COUNT(*) AS total_entries,
      COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(CASE WHEN payment_mode='cash' THEN amount ELSE 0 END),0) AS cash,
      COALESCE(SUM(CASE WHEN payment_mode!='cash' THEN amount ELSE 0 END),0) AS bank
    FROM expenses
    WHERE company_id=$1
      AND godown_id=$2
      AND date BETWEEN $3::date AND $4::date
    `,
    [
      company_id,
      godown_id,
      start_date || "2000-01-01",
      end_date || "2100-12-31",
    ]
  );

  res.json({ success: true, summary: result.rows[0] });
});

export default router;
