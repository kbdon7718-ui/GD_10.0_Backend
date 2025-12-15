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

      vendor_id,     // feriwala / kabadiwala
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
       3️⃣ FERIWALA HISAB
    ===================================================== */
    if (category === "Feriwala" && vendor_id) {
      // withdrawal record
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
          $4,$5,$6,NOW()
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

      // daily balance update
      await client.query(
        `
        INSERT INTO feriwala_daily_balances
        (
          company_id,
          godown_id,
          vendor_id,
          date,
          balance
        )
        VALUES
        ($1,$2,$3,$4,-$5)
        ON CONFLICT (vendor_id, date)
        DO UPDATE SET
          balance = feriwala_daily_balances.balance - EXCLUDED.balance
        `,
        [
          company_id,
          godown_id,
          vendor_id,
          date || new Date(),
          amount,
        ]
      );
    }

    /* =====================================================
       4️⃣ KABADIWALA HISAB + DAILY BALANCE
    ===================================================== */
    if (category === "Kabadiwala" && vendor_id) {
      // payment record
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
          $1,$2,$3,$4,$5,NOW()
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

      // daily balance update
      await client.query(
        `
        INSERT INTO kabadiwala_daily_balance
        (
          company_id,
          godown_id,
          vendor_id,
          date,
          previous_balance,
          purchase_amount,
          paid_amount,
          current_balance
        )
        VALUES
        ($1,$2,$3,$4,0,0,$5,-$5)
        ON CONFLICT (company_id, godown_id, vendor_id, date)
        DO UPDATE SET
          paid_amount = kabadiwala_daily_balance.paid_amount + EXCLUDED.paid_amount,
          current_balance = kabadiwala_daily_balance.current_balance - EXCLUDED.paid_amount,
          updated_at = NOW()
        `,
        [
          company_id,
          godown_id,
          vendor_id,
          date || new Date(),
          amount,
        ]
      );
    }

    /* =====================================================
       5️⃣ ROKADI TRANSACTION
       (balance auto-updated by trigger)
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


/* =====================================================
   DELETE EXPENSE (WITH ROLLBACK)
===================================================== */
router.delete("/delete/:id", async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query("BEGIN");

    // 1️⃣ Get expense
    const expRes = await client.query(
      `SELECT * FROM expenses WHERE id=$1`,
      [id]
    );

    if (expRes.rowCount === 0) {
      throw new Error("Expense not found");
    }

    const exp = expRes.rows[0];

    // 2️⃣ Reverse Rokadi
    if (exp.account_id) {
      await client.query(
        `
        INSERT INTO rokadi_transactions
        (
          account_id, company_id, godown_id,
          type, amount, category, reference, created_at
        )
        VALUES
        ($1,$2,$3,'credit',$4,'expense-reversal',$5,NOW())
        `,
        [
          exp.account_id,
          exp.company_id,
          exp.godown_id,
          exp.amount,
          `DELETE: ${exp.category} ${exp.paid_to || ""}`,
        ]
      );
    }

    // 3️⃣ Reverse Feriwala
    if (exp.category === "Feriwala") {
      await client.query(
        `
        UPDATE feriwala_daily_balances
        SET balance = balance + $1
        WHERE vendor_id = (
          SELECT vendor_id FROM feriwala_withdrawals
          WHERE note = $2
          LIMIT 1
        )
        AND date = $3
        `,
        [exp.amount, exp.description || "", exp.date]
      );
    }

    // 4️⃣ Reverse Kabadiwala
    if (exp.category === "Kabadiwala") {
      await client.query(
        `
        UPDATE kabadiwala_daily_balance
        SET
          paid_amount = paid_amount - $1,
          current_balance = current_balance + $1,
          updated_at = NOW()
        WHERE company_id=$2
          AND godown_id=$3
          AND date=$4
        `,
        [
          exp.amount,
          exp.company_id,
          exp.godown_id,
          exp.date,
        ]
      );
    }

    // 5️⃣ Delete expense
    await client.query(
      `DELETE FROM expenses WHERE id=$1`,
      [id]
    );

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE EXPENSE:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* =====================================================
   UPDATE EXPENSE (SAFE EDIT)
===================================================== */
router.put("/update/:id", async (req, res) => {
  const { id } = req.params;
  const { category, description, paid_to, amount } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE expenses
      SET
        category = $1,
        description = $2,
        paid_to = $3,
        amount = $4
      WHERE id = $5
      RETURNING *;
      `,
      [
        category,
        description,
        paid_to,
        Number(amount),
        id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ UPDATE EXPENSE:", err.message);
    res.status(500).json({ success: false });
  }
});


export default router;
