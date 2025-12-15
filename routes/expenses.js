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

      labour_id,
      vendor_id,
      vendor_type,

      created_by,
    } = req.body;

    if (!company_id || !godown_id || !amount || !category) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    /* ===============================
       NORMALIZE PAYMENT MODE
    =============================== */
    const pm = (payment_mode || "cash").toLowerCase();

    /* =====================================================
       1️⃣ SAVE EXPENSE (SOURCE OF TRUTH)
    ===================================================== */
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
        vendor_id,
        vendor_type,
        labour_id,
        created_by,
        created_at
      )
      VALUES
      (
        uuid_generate_v4(),
        $1,$2,$3,
        $4,$5,$6,
        $7,$8,
        $9,$10,
        $11,$12,
        NOW()
      )
      RETURNING id;
      `,
      [
        company_id,
        godown_id,
        date || new Date(),
        category,
        description || "",
        amount,
        payment_mode || "Cash",
        paid_to || "",
        vendor_id || null,
        vendor_type || null,
        labour_id || null,
        created_by || "manager",
      ]
    );

    const expense_id = expenseRes.rows[0].id;

    /* =====================================================
       2️⃣ LABOUR PAYMENT
    ===================================================== */
    if (category === "Labour" && labour_id) {
      await client.query(
        `
        INSERT INTO labour_withdrawals
        (
          id, company_id, godown_id, labour_id,
          date, amount, mode, type, created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,$2,$3,
          $4,$5,$6,'salary',NOW()
        )
        `,
        [
          company_id,
          godown_id,
          labour_id,
          date || new Date(),
          amount,
          pm,
        ]
      );
    }

    /* =====================================================
       3️⃣ FERIWALA PAYMENT
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
    }

    /* =====================================================
       4️⃣ KABADIWALA PAYMENT
    ===================================================== */
    if (category === "Kabadiwala" && vendor_id) {
      const kabRes = await client.query(
        `
        INSERT INTO kabadiwala_records
        (
          id, company_id, godown_id, vendor_id,
          kabadiwala_name, date,
          total_amount, payment_mode, payment_status, created_at
        )
        SELECT
          uuid_generate_v4(),
          $1,$2,v.id,
          v.name,$3,
          0,$4,'paid',NOW()
        FROM vendors v
        WHERE v.id=$5
        RETURNING id;
        `,
        [
          company_id,
          godown_id,
          date || new Date(),
          pm,
          vendor_id,
        ]
      );

      await client.query(
        `
        INSERT INTO kabadiwala_payments
        (
          id, kabadiwala_id, amount, mode, note, date, created_at
        )
        VALUES
        (
          uuid_generate_v4(),
          $1,$2,$3,$4,$5,NOW()
        )
        `,
        [
          kabRes.rows[0].id,
          amount,
          pm,
          description || "",
          date || new Date(),
        ]
      );
    }

    /* =====================================================
       5️⃣ ROKADI DEBIT (ONLY ONCE)
       Cash → cash
       UPI / Bank Transfer → bank
    ===================================================== */
    const rokadiType =
      pm === "cash" ? "cash" : "bank";

    const rokadiRes = await client.query(
      `
      SELECT id
      FROM rokadi_accounts
      WHERE company_id=$1 AND godown_id=$2 AND account_type=$3
      LIMIT 1
      `,
      [company_id, godown_id, rokadiType]
    );

    if (rokadiRes.rowCount === 0) {
      throw new Error(`Rokadi ${rokadiType} account not found`);
    }

    const rokadi_id = rokadiRes.rows[0].id;

    await client.query(
      `
      INSERT INTO rokadi_transactions
      (
        id, company_id, godown_id, account_id,
        type, amount, category, reference, created_at
      )
      VALUES
      (
        uuid_generate_v4(),
        $1,$2,$3,
        'debit',$4,'expense',$5,NOW()
      )
      `,
      [
        company_id,
        godown_id,
        rokadi_id,
        amount,
        `${category}: ${paid_to || description}`,
      ]
    );

    await client.query(
      `
      UPDATE rokadi_accounts
      SET balance = balance - $1
      WHERE id=$2
      `,
      [amount, rokadi_id]
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
   OWNER — LIST EXPENSES
===================================================== */
router.get("/list", async (req, res) => {
  const { company_id, godown_id, date } = req.query;

  const result = await pool.query(
    `
    SELECT *
    FROM expenses
    WHERE company_id=$1 AND godown_id=$2
      AND ($3::date IS NULL OR date::date=$3::date)
    ORDER BY created_at DESC
    `,
    [company_id, godown_id, date || null]
  );

  res.json({ success: true, expenses: result.rows });
});

/* =====================================================
   OWNER — SUMMARY
===================================================== */
router.get("/summary", async (req, res) => {
  const { company_id, godown_id, start_date, end_date } = req.query;

  const result = await pool.query(
    `
    SELECT
      COUNT(*) AS total_entries,
      COALESCE(SUM(amount),0) AS total_amount,
      COALESCE(SUM(CASE WHEN LOWER(payment_mode)='cash' THEN amount ELSE 0 END),0) AS cash,
      COALESCE(SUM(CASE WHEN LOWER(payment_mode) IN ('upi','bank','bank transfer') THEN amount ELSE 0 END),0) AS bank
    FROM expenses
    WHERE company_id=$1 AND godown_id=$2
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

export default router;
