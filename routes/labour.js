// backend/routes/labour.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ===================================================
   🟢 1. Add New Labour / Contractor (Owner)
=================================================== */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      name,
      contact,
      role,
      worker_type,
      daily_wage,
      monthly_salary,
      per_kg_rate,
      status = "Active",
      created_by,
    } = req.body;

    if (!company_id || !godown_id || !name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    const result = await client.query(
      `
      INSERT INTO labour
      (id, company_id, godown_id, name, contact, role, worker_type, daily_wage, monthly_salary, per_kg_rate, status, created_by, created_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *;
      `,
      [
        company_id,
        godown_id,
        name,
        contact || null,
        role || null,
        worker_type || "Labour",
        daily_wage || 0,
        monthly_salary || 0,
        per_kg_rate || 0,
        status,
        created_by || null,
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Labour added successfully",
      labour: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Add Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
   🟣 2. Fetch all labour / contractors
=================================================== */
router.get("/all", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    const result = await pool.query(
      `
      SELECT l.*,
        COALESCE(SUM(w.amount), 0) AS total_withdrawn,
        COALESCE(SUM(s.amount), 0) AS total_salary_earned
      FROM labour l
      LEFT JOIN labour_withdrawals w ON l.id = w.labour_id
      LEFT JOIN labour_salary s ON l.id = s.labour_id
      WHERE l.company_id = $1 AND l.godown_id = $2
      GROUP BY l.id
      ORDER BY l.created_at DESC;
      `,
      [company_id, godown_id]
    );

    res.json({ success: true, labour: result.rows });
  } catch (err) {
    console.error("❌ Fetch Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================================================
   🟠 3. Manager — Mark Attendance
   - Present → save attendance + auto add salary
   - Absent → NOT saved in DB
=================================================== */
router.post("/attendance/mark", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, labour_id, date, status } = req.body;

    await client.query("BEGIN");

    if (status.toLowerCase() === "present") {
      // Prevent duplicate present entries
      const exists = await client.query(
        `SELECT id FROM attendance WHERE labour_id=$1 AND date=$2`,
        [labour_id, date]
      );

      if (exists.rowCount > 0) {
        return res.status(400).json({ error: "Attendance already marked" });
      }

      // Save attendance
      await client.query(
        `
        INSERT INTO attendance
        (id, company_id, godown_id, labour_id, date, status, created_at)
        VALUES (uuid_generate_v4(), $1, $2, $3, $4, 'Present', NOW());
        `,
        [company_id, godown_id, labour_id, date]
      );

      // Get daily wage
      const wage = await client.query(
        `SELECT daily_wage FROM labour WHERE id=$1`,
        [labour_id]
      );

      const dailyWage = wage.rows[0]?.daily_wage || 0;

      // Salary entry
      await client.query(
  `
  INSERT INTO labour_salary (id, company_id, godown_id, labour_id, date, amount, paid, created_at)
  SELECT uuid_generate_v4(), $1, $2, $3, $4, $5, false, NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM labour_salary 
    WHERE labour_id = $3 AND date = $4
  );
  `,
  [company_id, godown_id, labour_id, date, dailyWage]
);
    }

    // ❌ If absent, do nothing (per requirement)

    await client.query("COMMIT");

    res.json({ success: true, message: `Attendance marked: ${status}` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Attendance Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
   🟢 4. Get Attendance for a Date (Manager)
=================================================== */
router.get("/attendance/by-date", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    const result = await pool.query(
      `
      SELECT labour_id, status
      FROM attendance
      WHERE company_id = $1 
        AND godown_id = $2 
        AND date = $3::date;
      `,
      [company_id, godown_id, date]
    );

    res.json({ success: true, attendance: result.rows });
  } catch (err) {
    console.error("❌ Attendance Fetch Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================================================
   🟡 5. Manager — Record Salary Withdrawal
=================================================== */
router.post("/withdraw", async (req, res) => {
  try {
    const { company_id, godown_id, labour_id, date, amount, mode } = req.body;

    if (!labour_id || !amount) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await pool.query(
      `
      INSERT INTO labour_withdrawals
      (id, company_id, godown_id, labour_id, date, amount, mode, created_at)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, NOW());
      `,
      [
        company_id,
        godown_id,
        labour_id,
        date,
        amount,
        mode || "cash",
      ]
    );

    res.json({ success: true, message: "Withdrawal recorded successfully" });
  } catch (err) {
    console.error("❌ Withdrawal Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================================================
   🟣 6. Lifetime Salary Summary (Owner)
   Joining Date → Today
=================================================== */
router.get("/salary/summary", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    const result = await pool.query(
      `
      SELECT 
        l.id AS labour_id,
        l.name AS labour_name,
        l.daily_wage,
        l.created_at AS joining_date,

        -- Total present days
        COALESCE((
          SELECT COUNT(*) 
          FROM attendance 
          WHERE labour_id = l.id
        ), 0) AS present_days,

        -- Total earned = sum of all daily wages
        COALESCE((
          SELECT SUM(amount)
          FROM labour_salary 
          WHERE labour_id = l.id
        ), 0) AS total_earned,

        -- Total withdrawn (salary taken)
        COALESCE((
          SELECT SUM(amount)
          FROM labour_withdrawals
          WHERE labour_id = l.id
        ), 0) AS total_paid,

        -- Remaining balance
        (
          COALESCE((
            SELECT SUM(amount) 
            FROM labour_salary 
            WHERE labour_id = l.id
          ), 0)
          -
          COALESCE((
            SELECT SUM(amount)
            FROM labour_withdrawals
            WHERE labour_id = l.id
          ), 0)
        ) AS net_balance

      FROM labour l
      WHERE l.company_id = $1
        AND l.godown_id = $2
        AND l.worker_type = 'Labour'
      ORDER BY l.name;
      `,
      [company_id, godown_id]
    );

    res.json({ success: true, summary: result.rows });
  } catch (err) {
    console.error("❌ Salary Summary Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================================================
   🟠 6.5 Update Labour / Contractor (Owner)
=================================================== */
router.put("/:labour_id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { labour_id } = req.params;
    const {
      name,
      contact,
      role,
      daily_wage,
      monthly_salary,
      per_kg_rate,
      status,
    } = req.body;

    if (!labour_id) {
      return res.status(400).json({ error: "Missing labour ID" });
    }

    await client.query("BEGIN");

    const result = await client.query(
      `
      UPDATE labour
      SET
        name = $1,
        contact = $2,
        role = $3,
        daily_wage = $4,
        monthly_salary = $5,
        per_kg_rate = $6,
        status = COALESCE($7, status)
      WHERE id = $8
      RETURNING *;
      `,
      [
        name,
        contact,
        role,
        daily_wage || 0,
        monthly_salary || 0,
        per_kg_rate || 0,
        status,
        labour_id,
      ]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Labour not found" });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Labour updated successfully",
      labour: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Update Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


    /* ===================================================
   🔴 7. Delete Labour (Owner)
=================================================== */
router.delete("/:labour_id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { labour_id } = req.params;

    if (!labour_id) {
      return res.status(400).json({ error: "Missing labour ID" });
    }

    await client.query("BEGIN");

    // Delete the labour
    const result = await client.query(
      `DELETE FROM labour WHERE id = $1 RETURNING id`,
      [labour_id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Labour not found" });
    }

    await client.query("COMMIT");

    res.json({ success: true, message: "Labour deleted successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Delete Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
   🔵 8. Get Labour History (Ledger)
=================================================== */
router.get("/history/:labour_id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { labour_id } = req.params;
    const { company_id, godown_id } = req.query;

    if (!labour_id || !company_id || !godown_id) {
      return res.status(400).json({ error: "Missing required parameters" });
    }

    // Verify labour belongs to the specified company and godown
    const labourCheck = await client.query(
      "SELECT id, name, role, contact, daily_wage, monthly_salary FROM labour WHERE id = $1 AND company_id = $2 AND godown_id = $3",
      [labour_id, company_id, godown_id]
    );

    if (labourCheck.rowCount === 0) {
      return res.status(404).json({ error: "Labour not found" });
    }

    // Get salary entries
    const salaryQuery = await client.query(
      `SELECT id, date, amount, paid, 'Salary' as entry_type, 
              CASE WHEN paid = true THEN 'Paid' ELSE 'Pending' END as mode,
              created_at
       FROM labour_salary 
       WHERE labour_id = $1 AND company_id = $2 AND godown_id = $3
       ORDER BY date DESC, created_at DESC`,
      [labour_id, company_id, godown_id]
    );

    // Get withdrawal entries
    const withdrawalQuery = await client.query(
      `SELECT id, date, amount, 'Payment' as entry_type, 
              CASE WHEN mode IS NOT NULL THEN mode ELSE 'Cash' END as mode,
              created_at
       FROM labour_withdrawals 
       WHERE labour_id = $1 AND company_id = $2 AND godown_id = $3
       ORDER BY date DESC, created_at DESC`,
      [labour_id, company_id, godown_id]
    );

    // Get expense entries related to this labour
    const expenseQuery = await client.query(
      `SELECT id, date, amount, 'Expense' as entry_type, 
              transaction_mode as mode, description
       FROM expenses 
       WHERE labour_id = $1 AND company_id = $2 AND godown_id = $3
       ORDER BY date DESC, created_at DESC`,
      [labour_id, company_id, godown_id]
    );

    // Combine all entries with improved fields
    const allEntries = [
      ...salaryQuery.rows.map(entry => ({
        ...entry,
        source: 'salary',
        label: 'Salary Credited',
        remarks: entry.remarks || '',
        mode: entry.mode || 'N/A',
        type: 'credit',
      })),
      ...withdrawalQuery.rows.map(entry => ({
        ...entry,
        source: 'withdrawal',
        label: 'Withdrawal',
        remarks: entry.remarks || '',
        mode: entry.mode || 'Cash',
        type: 'debit',
      })),
      ...expenseQuery.rows.map(entry => ({
        ...entry,
        source: 'expense',
        label: 'Expense',
        remarks: entry.description || '',
        mode: entry.mode || 'N/A',
        type: 'debit',
      }))
    ];

    // Sort by date (oldest first for running balance)
    allEntries.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateA - dateB;
    });

    // Calculate totals and running balance
    let totalEarned = 0;
    let totalPaid = 0;
    let runningBalance = 0;
    const entriesWithBalance = allEntries.map(entry => {
      const amount = parseFloat(entry.amount) || 0;
      if (entry.type === 'credit') {
        totalEarned += amount;
        runningBalance += amount;
      } else if (entry.type === 'debit') {
        totalPaid += amount;
        runningBalance -= amount;
      }
      return { ...entry, running_balance: runningBalance };
    });

    // Sort back to latest first for frontend display
    entriesWithBalance.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateB - dateA;
    });

    const remaining = totalEarned - totalPaid;

    res.json({
      success: true,
      entries: entriesWithBalance,
      totals: {
        total_earned: totalEarned,
        total_paid: totalPaid,
        remaining: remaining
      },
      labour: labourCheck.rows[0]
    });

  } catch (err) {
    console.error("❌ Get Labour History Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


export default router;
