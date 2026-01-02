import express from "express";
import { pool } from "../config/db.js";
import { randomUUID } from "crypto";

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
      vendor_id, // feriwala / kabadiwala
    } = req.body;

    if (!company_id || !godown_id || !amount || !category) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    await client.query("BEGIN");

    /* ===============================
       PAYMENT MODE
    =============================== */
    const pm = (payment_mode || "cash").toLowerCase();
    const rokadiType = pm === "cash" ? "cash" : "bank";

    /* ===============================
       FIND ROKADI ACCOUNT
    =============================== */
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

    /* ===============================
       SAVE EXPENSE
    =============================== */
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
      ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NOW())
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
      ]
    );

    const expense_id = expenseRes.rows[0].id;

    /* =====================================================
       FERIWALA HISAB
    ===================================================== */
    if (category === "Feriwala" && vendor_id) {
      await client.query(
        `
        INSERT INTO feriwala_withdrawals
        (
          id, company_id, godown_id, vendor_id,
          amount, date, note, created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,$2,$3,
          $4::numeric,$5,$6,NOW()
        )
        `,
        [
          company_id,
          godown_id,
          vendor_id,
          amount,
          date || new Date(),
          description || "",
        ]
      );
    }

    /* =====================================================
       KABADIWALA HISAB
    ===================================================== */
    if (category === "Kabadiwala" && vendor_id) {
      await client.query(
        `
        INSERT INTO kabadiwala_payments
        (
          id,
          vendor_id,
          amount,
          mode,
          note,
          date,
          created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,
          $2::numeric,
          $3,
          $4,
          $5,
          NOW()
        )
        `,
        [
          vendor_id,
          amount,
          pm,
          description || "",
          date || new Date(),
        ]
      );
    }

    /* =====================================================
       ROKADI TRANSACTION
    ===================================================== */
    const displayRef = `${category}: ${paid_to || description || ""}`;
    const displayRefVal = displayRef && String(displayRef).trim() ? String(displayRef).trim() : null;
    const txnId = randomUUID();
    const internalRef = `expense:${expense_id}`;
    const metadata = {
      source: "expense",
      expense_id,
      note: displayRefVal,
    };

    await client.query(
      `
      INSERT INTO rokadi_transactions
        (id, account_id, company_id, godown_id, type, amount, category, reference, metadata, created_at)
      VALUES
        ($1,$2,$3,$4,'debit',$5::numeric,'expense',$6,$7::jsonb,NOW())
      `,
      [txnId, account_id, company_id, godown_id, amount, internalRef, JSON.stringify(metadata)]
    );

    await client.query(
      `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id=$2`,
      [amount, account_id]
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

/* =====================================================
   DELETE EXPENSE (SAFE)
===================================================== */
router.delete("/delete/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const expRes = await client.query(
      `SELECT * FROM expenses WHERE id=$1`,
      [req.params.id]
    );

    if (expRes.rowCount === 0) {
      throw new Error("Expense not found");
    }

    const exp = expRes.rows[0];

    await client.query(
      `
      INSERT INTO rokadi_transactions
      (
        account_id, company_id, godown_id,
        type, amount, category, reference, created_at
      )
      VALUES
      ($1,$2,$3,'credit',$4::numeric,'expense-reversal',$5,NOW())
      `,
      [
        exp.account_id,
        exp.company_id,
        exp.godown_id,
        exp.amount,
        `expense_reversal:${req.params.id}:${randomUUID()}`,
      ]
    );

    await client.query(`DELETE FROM expenses WHERE id=$1`, [req.params.id]);

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =====================================================
   UPDATE EXPENSE (SAFE)
===================================================== */
router.put("/update/:id", async (req, res) => {
  const { category, description, paid_to, amount } = req.body;

  const result = await pool.query(
    `
    UPDATE expenses
    SET
      category=$1,
      description=$2,
      paid_to=$3,
      amount=$4::numeric
    WHERE id=$5
    RETURNING id
    `,
    [category, description, paid_to, amount, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ success: false });
  }

  res.json({ success: true });
});

export default router;
