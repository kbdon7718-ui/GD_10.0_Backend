import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* =========================================================
   GET ROKADI ACCOUNTS (CASH IN HAND)
   Used by RokadiUpdate.jsx
========================================================= */
router.get("/accounts", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id & godown_id required" });
    }

    const q = `
      SELECT
        id,
        account_name,
        account_type,
        balance
      FROM rokadi_accounts
      WHERE company_id = $1
        AND godown_id = $2
      ORDER BY created_at ASC
    `;

    const r = await pool.query(q, [company_id, godown_id]);

    res.json({ success: true, accounts: r.rows });
  } catch (err) {
    console.error("❌ ROKADI ACCOUNTS ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   GET ROKADI TRANSACTIONS (LEDGER)
========================================================= */
router.get("/transactions", async (req, res) => {
  try {
    const { company_id, godown_id, account_id, date } = req.query;

    if (!company_id || !godown_id || !account_id) {
      return res.status(400).json({ error: "Missing required params" });
    }

    const q = `
      SELECT
        id,
        type,
        amount,
        category,
        reference,
        created_at::date AS date
      FROM rokadi_transactions
      WHERE company_id = $1
        AND godown_id = $2
        AND account_id = $3
        AND ($4::date IS NULL OR created_at::date = $4::date)
      ORDER BY created_at DESC
    `;

    const r = await pool.query(q, [
      company_id,
      godown_id,
      account_id,
      date || null,
    ]);

    res.json({ success: true, transactions: r.rows });
  } catch (err) {
    console.error("❌ ROKADI TX ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   ADD ROKADI TRANSACTION
   type = credit | debit | transfer
========================================================= */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      account_id,
      related_account_id = null,
      type, // credit | debit | transfer
      amount,
      category = "",
      reference = "",
      created_by = null,
      date = new Date().toISOString().split("T")[0],
    } = req.body;

    if (!company_id || !godown_id || !account_id || !type || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    await client.query("BEGIN");

    /* -------- Insert transaction -------- */
    await client.query(
      `
      INSERT INTO rokadi_transactions
      (id, account_id, related_account_id, company_id, godown_id,
       type, amount, category, reference, created_by, created_at)
      VALUES
      (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
      [
        account_id,
        related_account_id,
        company_id,
        godown_id,
        type,
        amount,
        category,
        reference,
        created_by,
        date,
      ]
    );

    /* -------- Update balances -------- */
    if (type === "credit") {
      await client.query(
        `UPDATE rokadi_accounts SET balance = balance + $1 WHERE id = $2`,
        [amount, account_id]
      );
    }

    if (type === "debit") {
      await client.query(
        `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id = $2`,
        [amount, account_id]
      );
    }

    if (type === "transfer" && related_account_id) {
      // from account
      await client.query(
        `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id = $2`,
        [amount, account_id]
      );

      // to account
      await client.query(
        `UPDATE rokadi_accounts SET balance = balance + $1 WHERE id = $2`,
        [amount, related_account_id]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, message: "Rokadi updated successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ ROKADI ADD ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
