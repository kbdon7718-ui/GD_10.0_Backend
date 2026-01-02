import express from "express";
import { pool } from "../config/db.js";
import { randomUUID } from "crypto";

const router = express.Router();

/* =========================================================
   GET BANK ACCOUNTS (ONLY BANK)
========================================================= */
router.get("/accounts", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id & godown_id required" });
    }

    const result = await pool.query(
      `
      SELECT id, account_name, balance
      FROM rokadi_accounts
      WHERE company_id = $1
        AND godown_id = $2
        AND account_type = 'bank'
      ORDER BY created_at ASC
      `,
      [company_id, godown_id]
    );

    res.json({ success: true, accounts: result.rows });
  } catch (err) {
    console.error("❌ BANK ACCOUNTS:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   BANK STATEMENT (CREDIT + DEBIT LEDGER)
========================================================= */
router.get("/statement", async (req, res) => {
  try {
    const { company_id, godown_id, account_id } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        error: "company_id & godown_id required",
      });
    }

    const params = [company_id, godown_id];
    let accountFilter = "";

    if (account_id) {
      params.push(account_id);
      accountFilter = `AND rt.account_id = $3`;
    }

    const result = await pool.query(
      `
      SELECT
        rt.id,
        rt.type,               -- credit | debit
        rt.amount,
        rt.category,
        COALESCE(rt.metadata->>'note', rt.reference) AS reference,
        rt.created_at AS date,
        ra.account_name
      FROM rokadi_transactions rt
      JOIN rokadi_accounts ra ON ra.id = rt.account_id
      WHERE rt.company_id = $1
        AND rt.godown_id = $2
        AND ra.account_type = 'bank'
        ${accountFilter}
      ORDER BY rt.created_at ASC
      `,
      params
    );

    res.json({
      success: true,
      transactions: result.rows,
    });
  } catch (err) {
    console.error("❌ BANK STATEMENT:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   ADD BANK CREDIT (MANUAL)
   🔒 NO BALANCE UPDATE HERE (TRIGGER HANDLES IT)
========================================================= */
router.post("/credit", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      account_id,
      amount,
      category = "bank_credit",
      reference = "",
      date,
    } = req.body;

    if (!company_id || !godown_id || !account_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    const note = reference && String(reference).trim() ? String(reference).trim() : null;
    const txnId = randomUUID();
    const internalRef = `bank_credit:${txnId}`;
    const metadata = note ? { note } : {};

    await pool.query(
      `
      INSERT INTO rokadi_transactions
      (
        id,
        account_id,
        company_id,
        godown_id,
        type,
        amount,
        category,
        reference,
        metadata,
        created_at
      )
      VALUES
      (
        $1,
        $2,$3,$4,'credit',$5,$6,$7,$8,$9::jsonb,$10
      )
      `,
      [
        txnId,
        account_id,
        company_id,
        godown_id,
        amount,
        category,
        internalRef,
        JSON.stringify(metadata),
        date ? `${date} 00:00:00` : new Date(),
      ]
    );

    await pool.query(
      `UPDATE rokadi_accounts SET balance = balance + $1 WHERE id = $2`,
      [amount, account_id]
    );

    res.json({ success: true, message: "Bank credited successfully" });
  } catch (err) {
    console.error("❌ BANK CREDIT:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================
   ADD BANK DEBIT
   🔒 NO BALANCE UPDATE HERE
========================================================= */
router.post("/debit", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      account_id,
      amount,
      category = "bank_debit",
      reference = "",
      date,
    } = req.body;

    if (!company_id || !godown_id || !account_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    const note = reference && String(reference).trim() ? String(reference).trim() : null;
    const txnId = randomUUID();
    const internalRef = `bank_debit:${txnId}`;
    const metadata = note ? { note } : {};

    await pool.query(
      `
      INSERT INTO rokadi_transactions
      (
        id,
        account_id,
        company_id,
        godown_id,
        type,
        amount,
        category,
        reference,
        metadata,
        created_at
      )
      VALUES
      (
        $1,
        $2,$3,$4,'debit',$5,$6,$7,$8,$9::jsonb,$10
      )
      `,
      [
        txnId,
        account_id,
        company_id,
        godown_id,
        amount,
        category,
        internalRef,
        JSON.stringify(metadata),
        date ? `${date} 00:00:00` : new Date(),
      ]
    );

    await pool.query(
      `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id = $2`,
      [amount, account_id]
    );

    res.json({ success: true, message: "Bank debited successfully" });
  } catch (err) {
    console.error("❌ BANK DEBIT:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
