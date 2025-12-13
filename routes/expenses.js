// backend/routes/expenses.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/**
 * ✅ MANAGER — Add Expense Entry
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      account_id,
      category,
      description,
      amount,
      payment_mode,
      paid_to,
      created_by,
    } = req.body;

    if (!company_id || !godown_id || !account_id || !amount || !paid_to) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    const expenseResult = await client.query(
      `
      INSERT INTO expenses 
      (id, company_id, godown_id, date, category, description, amount, payment_mode, account_id, paid_to, created_by, created_at)
      VALUES (uuid_generate_v4(), $1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING id;
      `,
      [
        company_id,
        godown_id,
        category || "General",
        description || "No description",
        amount,
        payment_mode || "Cash",
        account_id,
        paid_to,
        created_by || null,
      ]
    );

    const expenseId = expenseResult.rows[0].id;

    // 🔍 Labour auto-entry
    if (category === "Labour") {
      const labourResult = await client.query(
        `
        SELECT id FROM labour 
        WHERE LOWER(name) = LOWER($1)
          AND company_id = $2
          AND godown_id = $3
        LIMIT 1
        `,
        [paid_to, company_id, godown_id]
      );

      if (labourResult.rowCount > 0) {
        await client.query(
          `
          INSERT INTO labour_withdrawals
          (id, company_id, godown_id, labour_id, date, amount, mode, type, created_at)
          VALUES (uuid_generate_v4(), $1, $2, $3, CURRENT_DATE, $4, $5, 'salary', NOW());
          `,
          [
            company_id,
            godown_id,
            labourResult.rows[0].id,
            amount,
            payment_mode || "cash",
          ]
        );
      }
    }

    // Account transaction
    /* =====================================================
   🔻 AUTO DEBIT ROKADI ON EXPENSE
===================================================== */

// decide source: cash or bank
const rokadiAccountType =
  payment_mode && payment_mode.toLowerCase() === "cash"
    ? "cash"
    : "bank";

// get rokadi account
const rokadiAccResult = await client.query(
  `
  SELECT id, balance
  FROM rokadi_accounts
  WHERE company_id = $1
    AND godown_id = $2
    AND account_type = $3
  LIMIT 1
  `,
  [company_id, godown_id, rokadiAccountType]
);

if (rokadiAccResult.rowCount === 0) {
  throw new Error(`Rokadi ${rokadiAccountType} account not found`);
}

const rokadiAccountId = rokadiAccResult.rows[0].id;

// insert rokadi transaction (DEBIT)
await client.query(
  `
  INSERT INTO rokadi_transactions
  (id, company_id, godown_id, account_id,
   type, amount, category, reference, created_at)
  VALUES
  (uuid_generate_v4(), $1, $2, $3,
   'debit', $4, 'expense', $5, NOW())
  `,
  [
    company_id,
    godown_id,
    rokadiAccountId,
    amount,
    `Expense: ${paid_to} (${description || "daily expense"})`,
  ]
);

// update rokadi balance
await client.query(
  `
  UPDATE rokadi_accounts
  SET balance = balance - $1
  WHERE id = $2
  `,
  [amount, rokadiAccountId]
);
  
    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      expense_id: expenseId,
      message: "Expense recorded successfully",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * 🧾 OWNER — Fetch Expenses (Exact Date)
 */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    const result = await pool.query(
      `
      SELECT 
        e.*,
        a.name AS account_name,
        u.name AS created_by_name
      FROM expenses e
      LEFT JOIN accounts a ON e.account_id = a.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE e.company_id = $1
        AND e.godown_id = $2
        AND ($3::date IS NULL OR e.date::date = $3::date)
      ORDER BY e.created_at DESC;
      `,
      [company_id, godown_id, date || null]
    );

    res.json({ success: true, expenses: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 OWNER — Expense Summary
 */
router.get("/summary", async (req, res) => {
  const { company_id, godown_id, start_date, end_date } = req.query;

  const result = await pool.query(
    `
    SELECT
      COUNT(*) AS total_expenses,
      COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'cash' THEN amount ELSE 0 END),0) AS total_cash,
      COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'upi' THEN amount ELSE 0 END),0) AS total_upi,
      COALESCE(SUM(CASE WHEN LOWER(payment_mode) IN ('bank','bank transfer') THEN amount ELSE 0 END),0) AS total_bank
    FROM expenses
    WHERE company_id = $1
      AND godown_id = $2
      AND date BETWEEN $3::date AND $4::date;
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

/**
 * ✏️ OWNER — Update Expense (EDIT)
 */
router.put("/update/:id", async (req, res) => {
  const { id } = req.params;
  const { category, description, amount, paid_to } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE expenses
      SET
        category = $1,
        description = $2,
        amount = $3,
        paid_to = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *;
      `,
      [category, description, amount, paid_to, id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ success: false, error: "Expense not found" });

    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 🗑️ OWNER — Delete Expense
 */
router.delete("/delete/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 RETURNING *;`,
      [id]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Expense not found" });

    res.json({ success: true, message: "Expense deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
