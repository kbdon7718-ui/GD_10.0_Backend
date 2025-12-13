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
   ADD ROKADI TRANSACTION
   ✅ MANUAL ENTRY = CREDIT ONLY
========================================================= */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      account_id,
      type,
      amount,
      category = "manual cash",
      reference = "",
      created_by = null,
      date,
    } = req.body;

    if (!company_id || !godown_id || !account_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    // 🔒 manual = credit only
    if (type !== "credit") {
      return res.status(400).json({
        error: "Only CREDIT entries are allowed manually",
      });
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO rokadi_transactions
      (id, account_id, company_id, godown_id,
       type, amount, category, reference, created_by, created_at)
      VALUES
      (uuid_generate_v4(), $1, $2, $3,
       'credit', $4, $5, $6, $7, $8)
      `,
      [
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

    await client.query("COMMIT");

    res.json({ success: true, message: "Cash credited successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ ROKADI ADD:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   AUTO DEBIT BY PAYMENT MODE
========================================================= */
router.post("/debit", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      amount,
      payment_mode,
      category,
      reference = "",
      date,
    } = req.body;

    if (!company_id || !godown_id || !amount || !payment_mode) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    await client.query("BEGIN");

    const accountType = payment_mode === "cash" ? "cash" : "bank";

    const accRes = await client.query(
      `
      SELECT id
      FROM rokadi_accounts
      WHERE company_id = $1
        AND godown_id = $2
        AND account_type = $3
      LIMIT 1
      `,
      [company_id, godown_id, accountType]
    );

    if (accRes.rowCount === 0) {
      throw new Error(`${accountType} account not found`);
    }

    await client.query(
      `
      INSERT INTO rokadi_transactions
      (id, account_id, company_id, godown_id,
       type, amount, category, reference, created_at)
      VALUES
      (uuid_generate_v4(), $1, $2, $3,
       'debit', $4, $5, $6, $7)
      `,
      [
        accRes.rows[0].id,
        company_id,
        godown_id,
        amount,
        category,
        reference,
        date ? `${date} 00:00:00` : new Date(),
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `₹${amount} debited from ${accountType}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ ROKADI DEBIT:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   CREDIT | DEBIT | TRANSFER (LEDGER ONLY)
========================================================= */
router.post("/transaction", async (req, res) => {
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
      date,
    } = req.body;

    if (!company_id || !godown_id || !account_id || !type || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    await client.query("BEGIN");

    // main entry
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

    // transfer second ledger entry
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
    console.error("❌ ROKADI TRANSACTION:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =========================================================
   GET ROKADI STATEMENT (BANK + CASH LEDGER)
========================================================= */
router.get("/transactions", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        error: "company_id and godown_id are required",
      });
    }

    const result = await pool.query(
      `
      SELECT
        rt.id,
        rt.type,
        rt.amount,
        rt.category,
        rt.reference,
        rt.created_at AS date,
        ra.account_name,
        ra.account_type
      FROM rokadi_transactions rt
      JOIN rokadi_accounts ra ON ra.id = rt.account_id
      WHERE rt.company_id = $1
        AND rt.godown_id = $2
      ORDER BY rt.created_at ASC
      `,
      [company_id, godown_id]
    );

    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    console.error("❌ ROKADI TRANSACTIONS:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
