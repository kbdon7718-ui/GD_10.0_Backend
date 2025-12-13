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
      date, // allow past date
    } = req.body;

    /* ---------- VALIDATION ---------- */
    if (!company_id || !godown_id || !account_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (amount <= 0) {
      return res.status(400).json({ error: "Amount must be > 0" });
    }

    // 🔒 HARD RULE
    if (type !== "credit") {
      return res.status(400).json({
        error: "Only CREDIT entries are allowed manually",
      });
    }

    await client.query("BEGIN");

    /* ---------- INSERT TRANSACTION ---------- */
    await client.query(
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
        created_by,
        created_at
      )
      VALUES
      (
        uuid_generate_v4(),
        $1,$2,$3,'credit',$4,$5,$6,$7,$8
      )
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

    /* ---------- UPDATE BALANCE ---------- */
    await client.query(
      `UPDATE rokadi_accounts SET balance = balance + $1 WHERE id = $2`,
      [amount, account_id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Cash credited successfully",
    });
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
      payment_mode, // cash | upi | bank
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

    /* ---------- FIND ACCOUNT AUTOMATICALLY ---------- */
    const accountType = payment_mode === "cash" ? "cash" : "bank";

    const accRes = await client.query(
      `
      SELECT id, balance
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

    const account = accRes.rows[0];

    if (account.balance < amount) {
      throw new Error("Insufficient balance");
    }

    /* ---------- INSERT TRANSACTION ---------- */
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
        account.id,
        company_id,
        godown_id,
        amount,
        category,
        reference,
        date ? `${date} 00:00:00` : new Date(),
      ]
    );

    /* ---------- UPDATE BALANCE ---------- */
    await client.query(
      `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id = $2`,
      [amount, account.id]
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
   /* ---------- UPDATE BALANCES ---------- */
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
  // debit from source
  await client.query(
    `UPDATE rokadi_accounts SET balance = balance - $1 WHERE id = $2`,
    [amount, account_id]
  );

  // credit to destination
  await client.query(
    `UPDATE rokadi_accounts SET balance = balance + $1 WHERE id = $2`,
    [amount, related_account_id]
  );

  // ledger entry for destination
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
