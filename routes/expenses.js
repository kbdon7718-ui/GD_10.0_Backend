// backend/routes/expenses.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/**
 * ✅ MANAGER — Add Expense Entry
 * Handles inserting expense + updates account + logs transaction.
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
      created_by, // optional (manager ID)
    } = req.body;

    if (!company_id || !godown_id || !account_id || !amount || !paid_to) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    // 1️⃣ Insert expense
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

    // 🔍  If category = "Labour", create labour withdrawal
if (category === "Labour") {
  const labourResult = await client.query(
    `SELECT id FROM labour 
     WHERE LOWER(name) = LOWER($1) 
       AND company_id = $2 
       AND godown_id = $3
     LIMIT 1`,
    [paid_to, company_id, godown_id]
  );

  if (labourResult.rowCount > 0) {
    const labourId = labourResult.rows[0].id;

    await client.query(
      `
      INSERT INTO labour_withdrawals
      (id, company_id, godown_id, labour_id, date, amount, mode, type, created_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, CURRENT_DATE, $4, $5, 'salary', NOW());
      `,
      [
        company_id,
        godown_id,
        labourId,
        amount,
        payment_mode || "cash",
      ]
    );
  }
}


    // 2️⃣ Add entry in account_transactions
    await client.query(
      `
      INSERT INTO account_transactions 
      (id, company_id, godown_id, account_id, type, amount, category, reference, metadata, created_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, 'debit', $4, 'expense', $5, '{}', NOW());
      `,
      [
        company_id,
        godown_id,
        account_id,
        amount,
        `Paid to ${paid_to} (${description || "expense"})`,
      ]
    );

    // 3️⃣ Update account balance
    await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2;`,
      [amount, account_id]
    );

    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      expense_id: expenseId,
      message: `Expense recorded successfully for ${paid_to}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Expense Add Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * 🧾 OWNER — Fetch All Expenses (Flexible Date Filter)
 */
/**
 * 🧾 OWNER — Fetch All Expenses (Exact Date Filter)
 */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;
    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "Missing required filters" });
    }

    const result = await pool.query(
      `
      SELECT 
        e.id,
        e.company_id,
        e.godown_id,
        e.date,
        e.category,
        e.description,
        e.amount,
        e.payment_mode,
        e.paid_to,
        e.account_id,
        e.created_by,
        e.created_at,
        a.name AS account_name,
        u.name AS created_by_name
      FROM expenses e
      LEFT JOIN accounts a ON e.account_id = a.id
      LEFT JOIN users u ON e.created_by = u.id
      WHERE e.company_id = $1 
        AND e.godown_id = $2
        -- 🔥 Exact date filtering
        AND ($3::date IS NULL OR e.date::date = $3::date)
      ORDER BY e.date DESC, e.created_at DESC;
      `,
      [company_id, godown_id, date || null]
    );

    res.status(200).json({ success: true, expenses: result.rows });
  } catch (err) {
    console.error("❌ Expense Fetch Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📅 OWNER — Filter by Date Range (Reports)
 */
router.get("/range", async (req, res) => {
  try {
    const { company_id, godown_id, start_date, end_date } = req.query;
    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "Missing required filters" });
    }

    const result = await pool.query(
      `
      SELECT 
        e.id, e.date, e.paid_to, e.amount, e.payment_mode, e.description, a.name AS account_name
      FROM expenses e
      LEFT JOIN accounts a ON e.account_id = a.id
      WHERE e.company_id = $1 
        AND e.godown_id = $2
        AND e.date BETWEEN $3::date AND $4::date
      ORDER BY e.date DESC;
      `,
      [
        company_id,
        godown_id,
        start_date || "2000-01-01",
        end_date || "2100-12-31",
      ]
    );

    res.status(200).json({ success: true, expenses: result.rows });
  } catch (err) {
    console.error("❌ Expense Range Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 OWNER — Expense Summary (for dashboard totals)
 */
router.get("/summary", async (req, res) => {
  try {
    const { company_id, godown_id, start_date, end_date } = req.query;
    if (!company_id || !godown_id)
      return res.status(400).json({ error: "Missing required filters" });

    const summary = await pool.query(
      `
      SELECT 
        COUNT(*) AS total_expenses,
        COALESCE(SUM(amount),0) AS total_amount,
        COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'cash' THEN amount ELSE 0 END),0) AS total_cash,
        COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'upi' THEN amount ELSE 0 END),0) AS total_upi,
        COALESCE(SUM(CASE WHEN LOWER(payment_mode) IN ('bank transfer','bank') THEN amount ELSE 0 END),0) AS total_bank
      FROM expenses
      WHERE company_id = $1 
        AND godown_id = $2
        AND (date BETWEEN $3::date AND $4::date);
      `,
      [
        company_id,
        godown_id,
        start_date || "2000-01-01",
        end_date || "2100-12-31",
      ]
    );

    res.json({ success: true, summary: summary.rows[0] });
  } catch (err) {
    console.error("❌ Expense Summary Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🗑️ ADMIN/OWNER — Delete Expense
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(`DELETE FROM expenses WHERE id = $1 RETURNING *;`, [id]);

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Expense not found" });

    await client.query("COMMIT");
    res.json({ success: true, message: "Expense deleted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Expense Delete Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
