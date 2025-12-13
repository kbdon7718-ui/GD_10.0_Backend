import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* =========================================================
   GET ROKADI ACCOUNTS (Cash + Bank)
========================================================= */
router.get("/accounts", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id & godown_id required" });
    }

    const result = await pool.query(
      `
      SELECT id, account_name, account_type, balance
      FROM rokadi_accounts
      WHERE company_id = $1 AND godown_id = $2
      ORDER BY created_at ASC
      `,
      [company_id, godown_id]
    );

    res.json({ success: true, accounts: result.rows });
  } catch (err) {
    console.error("❌ ROKADI ACCOUNTS:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   GET ROKADI TRANSACTIONS (Ledger)
========================================================= */
router.get("/transactions", async (req, res) => {
  try {
    const { company_id, godown_id, account_id, date } = req.query;

    if (!company_id || !godown_id || !account_id) {
      return res.status(400).json({ error: "Missing required params" });
    }

    const result = await pool.query(
      `
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
      `,
      [company_id, godown_id, account_id, date || null]
    );

    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    console.error("❌ ROKADI TX:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   ADD ROKADI TRANSACTION
   credit | debit | transfer
========================================================= */
router.post("/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      company_id,
      godown_id,
      account_id,
      related_account_id = null,
      type,
      amount,
      category = "",
      reference = "",
      created_by = null,
      date, // allow past date
    } = req.body;

    if (!company_id || !godown_id || !account_id || !type || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    await client.query("BEGIN");

    /* ---------- MAIN ENTRY ---------- */
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
        date ? `${date} 00:00:00` : new Date(),
      ]
    );

    /* ---------- TRANSFER SECOND ENTRY ---------- */
    if (type === "transfer" && related_account_id) {
      await client.query(
        `
        INSERT INTO rokadi_transactions
        (id, account_id, related_account_id, company_id, godown_id,
         type, amount, category, reference, created_by, created_at)
        VALUES
        (uuid_generate_v4(), $1,$2,$3,$4,'credit',$5,$6,$7,$8,$9)
        `,
        [
          related_account_id,
          account_id,
          company_id,
          godown_id,
          amount,
          category,
          reference,
          created_by,
          date ? `${date} 00:00:00` : new Date(),
        ]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, message: "Rokadi transaction added" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ ROKADI ADD:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
