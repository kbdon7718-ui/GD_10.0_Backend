// backend/routes/expenses.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ===================================================
   MANAGER — ADD EXPENSE (UNIFIED FLOW)
=================================================== */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      category,
      description,
      amount,
      payment_mode,
      paid_to,        // ✅ { id, name, type }
      labour_id,      // only for labour
      date,
      created_by,
    } = req.body;

    if (
      !company_id ||
      !godown_id ||
      !amount ||
      !paid_to ||
      !paid_to.type
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    /* ===================================================
       1️⃣ SAVE EXPENSE (MASTER LEDGER)
    =================================================== */
    const expenseRes = await client.query(
      `
      INSERT INTO expenses
      (
        id,
        company_id,
        godown_id,
        date,
        category,
        description,
        amount,
        payment_mode,
        paid_to,
        created_by,
        created_at
      )
      VALUES
      (
        uuid_generate_v4(),
        $1,$2,$3,
        $4,$5,$6,
        $7,$8,
        $9,
        NOW()
      )
      RETURNING id;
      `,
      [
        company_id,
        godown_id,
        date || new Date(),
        category || "General",
        description || "",
        Number(amount),
        payment_mode || "Cash",
        JSON.stringify(paid_to),   // ✅ JSONB
        created_by || "manager",
      ]
    );

    const expenseId = expenseRes.rows[0].id;

    /* ===================================================
       2️⃣ VENDOR / LABOUR SIDE ENTRIES
    =================================================== */

    // 🟡 LABOUR
    if (paid_to.type === "labour" && labour_id) {
      await client.query(
        `
        INSERT INTO labour_withdrawals
        (
          id,
          company_id,
          godown_id,
          labour_id,
          date,
          amount,
          mode,
          type,
          created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,$2,$3,
          $4,$5,
          $6,
          'salary',
          NOW()
        );
        `,
        [
          company_id,
          godown_id,
          labour_id,
          date || new Date(),
          Number(amount),
          payment_mode || "cash",
        ]
      );
    }

    // 🟡 FERIWALA
    if (paid_to.type === "feriwala") {
      await client.query(
        `
        INSERT INTO feriwala_payments
        (
          id,
          company_id,
          godown_id,
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
          $1,$2,$3,
          $4,$5,$6,$7,
          NOW()
        );
        `,
        [
          company_id,
          godown_id,
          paid_to.id,
          Number(amount),
          payment_mode || "cash",
          description || "Expense payment",
          date || new Date(),
        ]
      );
    }

    // 🟡 KABADIWALA
    if (paid_to.type === "kabadiwala") {
      await client.query(
        `
        INSERT INTO kabadiwala_payments
        (
          id,
          kabadiwala_id,
          amount,
          mode,
          note,
          date,
          created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,$2,$3,$4,$5,
          NOW()
        );
        `,
        [
          paid_to.id,
          Number(amount),
          payment_mode || "cash",
          description || "Expense payment",
          date || new Date(),
        ]
      );
    }

    /* ===================================================
       3️⃣ ROKADI DEBIT (SINGLE SOURCE OF TRUTH)
    =================================================== */
    const rokadiType =
      payment_mode && payment_mode.toLowerCase() === "cash"
        ? "cash"
        : "bank";

    const rAcc = await client.query(
      `
      SELECT id FROM rokadi_accounts
      WHERE company_id=$1 AND godown_id=$2 AND account_type=$3
      LIMIT 1;
      `,
      [company_id, godown_id, rokadiType]
    );

    if (rAcc.rowCount === 0) {
      throw new Error(`Rokadi ${rokadiType} account not found`);
    }

    const rokadiAccountId = rAcc.rows[0].id;

    await client.query(
      `
      INSERT INTO rokadi_transactions
      (
        id,
        company_id,
        godown_id,
        account_id,
        type,
        amount,
        category,
        reference,
        created_at
      )
      VALUES
      (
        uuid_generate_v4(),
        $1,$2,$3,
        'debit',
        $4,
        'expense',
        $5,
        NOW()
      );
      `,
      [
        company_id,
        godown_id,
        rokadiAccountId,
        Number(amount),
        `${paid_to.type}: ${paid_to.name}`,
      ]
    );

    await client.query(
      `
      UPDATE rokadi_accounts
      SET balance = balance - $1
      WHERE id = $2;
      `,
      [Number(amount), rokadiAccountId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      expense_id: expenseId,
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

/* ===================================================
   OWNER — LIST EXPENSES
=================================================== */
router.get("/list", async (req, res) => {
  const { company_id, godown_id, date } = req.query;

  const result = await pool.query(
    `
    SELECT *
    FROM expenses
    WHERE company_id=$1
      AND godown_id=$2
      AND ($3::date IS NULL OR date::date = $3::date)
    ORDER BY created_at DESC;
    `,
    [company_id, godown_id, date || null]
  );

  res.json({ success: true, expenses: result.rows });
});

/* ===================================================
   OWNER — EXPENSE SUMMARY
=================================================== */
router.get("/summary", async (req, res) => {
  const { company_id, godown_id, start_date, end_date } = req.query;

  const result = await pool.query(
    `
    SELECT
      COUNT(*) AS total_expenses,
      COALESCE(SUM(amount),0) AS total_amount
    FROM expenses
    WHERE company_id=$1
      AND godown_id=$2
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

/* ===================================================
   OWNER — DELETE EXPENSE (NO ROLLBACK YET)
=================================================== */
router.delete("/delete/:id", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    `DELETE FROM expenses WHERE id=$1 RETURNING *;`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Expense not found" });
  }

  res.json({ success: true });
});

export default router;
