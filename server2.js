const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const nodemailer = require("nodemailer");
const fs = require("fs"); // Required for file system operations (deleting local file)
const { google } = require("googleapis"); // Google APIs for Drive
require("dotenv").config(); // Load .env variables

// --- Google Drive Configuration ---
// 🔐 Load Google Drive credentials
let CREDENTIALS;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  // Production environment (Render)
  try {
    CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    console.log("✅ Google Drive credentials loaded from GOOGLE_CREDENTIALS_JSON environment variable.");
  } catch (e) {
    console.error("❌ Error parsing GOOGLE_CREDENTIALS_JSON environment variable. Please check its format:", e.message);
    // It's critical to have credentials, so exit if parsing fails in prod
    process.exit(1);
  }
} else {
  // Local development environment (if the JSON file is present and env var is not set)
  try {
    CREDENTIALS = require("./impactful-yeti-466710-a9-c4f8c0ecc621.json");
    console.log("✅ Google Drive credentials loaded from local JSON file (for development).");
  } catch (e) {
    console.error("❌ Google Drive credentials file './impactful-yeti-466710-a9-c4f8c0ecc621.json' not found locally.");
    console.error("   For local development, ensure this file exists. For Render, ensure GOOGLE_CREDENTIALS_JSON env var is set.");
    process.exit(1); // Exit if credentials are not found even locally
  }
}

// Ensure CREDENTIALS are loaded before proceeding
if (!CREDENTIALS) {
  console.error("❌ Critical: Google Drive credentials could not be loaded. Exiting.");
  process.exit(1);
}
const auth = new google.auth.GoogleAuth({
  credentials: CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const driveService = google.drive({ version: "v3", auth });
const SHARED_DRIVE_FOLDER_ID = process.env.SHAREDDRIVE; // ✅ Your shared drive ID
// --- End Google Drive Configuration ---

// OTP Store and generator
const otpStore = {}; // Maps email => OTP

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// File storage for PDF only (Multer configuration)
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const fileFilter = (req, file, cb) => {
  if (path.extname(file.originalname).toLowerCase() === ".pdf") {
    cb(null, true);
  } else {
    cb(new Error("Only PDF files are allowed"), false);
  }
};
const upload = multer({ storage, fileFilter });

const app = express();
const PORT = 3000;

// 🛡️ Middleware
app.use("/uploads", express.static("uploads"));
app.use(express.static("checkstatus"));
// app.use("/admin", express.static(path.join(__dirname, "admin")));

app.use(cors());
app.use(bodyParser.json());
app.use(express.json()); // Just in case

// 📡 MySQL Connection Pool

const db = mysql.createPool({
  host:  process.env.HOST,
  user: process.env.USER,
  password: process.env.PASSWORD, // update if needed
  database: process.env.DATABASE,
  port:process.env.PORT
});
async function testDbConnection() {
    try {
        // Attempt to get a connection from the pool
        const connection = await db.getConnection();
        // Execute a simple query (e.g., SELECT 1) to verify connectivity
        await connection.query("SELECT 1");
        // Release the connection back to the pool
        connection.release();
        console.log("✅ Database connection successful!");
    } catch (error) {
        console.error("❌ Database connection failed:", error.message);
        // It's often good practice to exit the process if the DB is critical
        // process.exit(1);
    }
}

// Call the test function when the server starts
testDbConnection();

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "mbarath@2005", // update if needed
//   database: "contract_db",
// });

// In your server.js file
// const db = mysql.createPool({
//   host: "bdxjukbfktwddi1nvyiu-mysql.services.clever-cloud.com", // ❌ REMOVE "http://"
//   user: "uzuwe0ngzwoxz9tr",
//   password: "3qgrBrAHmCaTaFzz0OjF",
//   database: "bdxjukbfktwddi1nvyiu",
//  port:3306
// });

// 📧 Nodemailer Setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ Send OTP
app.post("/send-otp", async (req, res) => {
  const { username, email } = req.body;

  try {
    // ✅ If both username and email are provided, check they match in DB
    if (username && email) {
      const [rows] = await db.execute(
        "SELECT * FROM users WHERE username = ? AND email = ?",
        [username, email]
      );

      if (rows.length === 0) {
        return res.status(400).json({ message: "Username and email do not match" });
      }
    }

    // ✅ If only email is provided (during signup), continue as usual
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const otp = generateOtp();
    otpStore[email] = otp;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is: ${otp}`,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ OTP sent to ${email}: ${otp}`);
    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.error("❌ Error in send-otp route:", err.message);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ✅ Verify OTP
app.post("/verify-otp", (req, res) => {
  const { email, enteredOtp } = req.body;
  const validOtp = otpStore[email];

  if (enteredOtp === validOtp) {
    delete otpStore[email]; // Clear OTP after successful verification
    res.json({ message: "OTP verified successfully" });
  } else {
    res.status(400).json({ message: "Invalid OTP" });
  }
});

// 📨 Email Sender Function (for new document uploads)
async function sendEmailNotification({ documentName, uploadedBy, documentLink }) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.APPROVER_EMAIL, // 👈 Send to Approver
    subject: "📄 New Document Uploaded for Review",
    html: `
      <h3>A new document has been uploaded.</h3>
      <p><strong>Uploaded By:</strong> ${uploadedBy}</p>
      <p><strong>Document:</strong> ${documentName}</p>
      <p><strong>Link:</strong> <a href="${documentLink}">Download PDF</a></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent to approver.");
  } catch (err) {
    console.error("❌ Failed to send email:", err.message);
  }
}

async function getUserEmailByUsername(username) {
  try {
    const [rows] = await db.execute("SELECT email FROM users WHERE username = ?", [username]);
    return rows.length > 0 ? rows[0].email : null;
  } catch (err) {
    console.error("Error fetching sender email:", err.message);
    return null;
  }
}

async function sendApprovalNotification({
  toEmails,
  documentName,
  uploadedBy,
  status,
  recipientRole,
}) {
  let subject = "";
  let html = "";

  if (recipientRole === "sender") {
    subject = `✅ Your document "${documentName}" has been approved`;
    html = `
      <h3>Good news!</h3>
      <p>Your document <strong>${documentName}</strong> uploaded by <strong>${uploadedBy}</strong> has been approved by the approver.</p>
      <p>It will now be reviewed by the reviewer.</p>
    `;
  } else if (recipientRole === "reviewer") {
    subject = `📄 New Document "${documentName}" Needs Your Review`;
    html = `
      <h3>Document Ready for Review</h3>
      <p>A new document <strong>${documentName}</strong> uploaded by <strong>${uploadedBy}</strong> has been approved and is ready for your review.</p>
      <p>Please log in to the system and take necessary action.</p>
    `;
  } else {
    subject = `📄 Document "${documentName}" Status: ${status}`;
    html = `
      <h3>Document Status Update</h3>
      <p><strong>${documentName}</strong> uploaded by <strong>${uploadedBy}</strong> is now marked as: <strong>${status}</strong>.</p>
    `;
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: toEmails,
    subject,
    html,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${recipientRole}:`, toEmails);
  } catch (error) {
    console.error(`❌ Failed to send email to ${recipientRole}:`, error.message);
  }
}

// 🔁 Legacy-style query wrapper using callback (Consider refactoring to async/await)
const queryWithCallback = async (sql, params, callback) => {
  try {
    const [results] = await db.query(sql, params);
    callback(null, results);
  } catch (err) {
    callback(err, null);
  }
};

// 📁 Legacy Documents API (callback style) - Can be refactored
app.get("/api/documents", (req, res) => {
  const sql = "SELECT * FROM documents ORDER BY id DESC";
  queryWithCallback(sql, [], (err, results) => {
    if (err) return res.status(500).send(err);
    res.json(results);
  });
});

// 🧾 Legacy Filtered Documents (callback style) - Can be refactored
app.get("/api/document", (req, res) => {
  const uploader = req.query.uploaded_by;
  let sql = "SELECT * FROM documents";
  let params = [];

  if (uploader) {
    sql += " WHERE uploaded_by LIKE ?";
    params.push(`%${uploader}%`);
  }

  queryWithCallback(sql, params, (err, results) => {
    if (err) return res.status(500).send(err);
    res.json(results);
  });
});

// 🔐 Signup Route (modern async/await)
app.post("/api/signup", async (req, res) => {
  const { first_name, last_name, username, email, password, phone } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.execute(
      "INSERT INTO users (first_name, last_name, username, email, password, phone) VALUES (?, ?, ?, ?, ?, ?)",
      [first_name, last_name, username, email, hashedPassword, phone]
    );
    res.json({ message: "Account created successfully" });
  } catch (err) {
    res.status(400).json({ message: "Username already exists or error occurred." });
  }
});

// 🔑 Login Route (modern async/await)
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const [results] = await db.execute("SELECT * FROM users WHERE username = ?", [username]);

    if (results.length === 0) {
      return res.status(401).json({ message: "User not found" });
    }

    const match = await bcrypt.compare(password, results[0].password);
    if (!match) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    res.json({
      message: "Login successful",
      user: {
        username: results[0].username,
        role: results[0].role,
      },
    });
  } catch (err) {
    res.status(500).send(err);
  }
});

// 🛠️ Additional Modern Routes (admin-login, reset-password, etc.)
app.post("/admin-login", async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await db.execute("SELECT * FROM admins WHERE username = ?", [username]);

  if (rows.length && rows[0].password === password) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid admin credentials" });
  }
});

app.post("/reset-password", async (req, res) => {
  const { username, email, newPassword } = req.body;
  const hashed = await bcrypt.hash(newPassword, 10);

  try {
    const [result] = await db.execute(
      `UPDATE users SET password = ? WHERE username = ? AND email = ?`,
      [hashed, username, email]
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ message: "User not found or email does not match" });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ message: "Error resetting password" });
  }
});



// 📄 Upload Document (Now uploads to Google Drive)
app.post("/upload", upload.single("file"), async (req, res) => {
  const { uploadedBy } = req.body;
  const documentName = req.file.originalname;
  const localPath = req.file.path; // Path to the temporarily stored file

  try {
    const fileMetadata = {
      name: `${Date.now()}-${documentName}`, // Give a unique name in Drive
      parents: [SHARED_DRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: "application/pdf",
      body: fs.createReadStream(localPath), // Read the locally saved file
    };

    // Upload file to Google Drive
    const driveResponse = await driveService.files.create({
      resource: fileMetadata,
      media,
      fields: "id",
      supportsAllDrives: true,
    });

    // Make the uploaded file publicly readable
    await driveService.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: "reader",
        type: "anyone", // Make it publicly accessible
      },
      supportsAllDrives: true,
    });

    // Construct the direct download link for the Google Drive file
    const documentLink = `https://drive.google.com/uc?id=${driveResponse.data.id}`;
    const istDate1 = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));


    // Insert document details into MySQL
    await db.execute(
      `INSERT INTO documents
       (document_name, document_link, uploaded_by, upload_time, approval_status, review_status)  VALUES (?, ?, ?, ?, ?, ?)`,
      [documentName, documentLink, uploadedBy,istDate1, "Pending", "Pending"]
    );

    // Send email notification about the new upload
    await sendEmailNotification({ documentName, uploadedBy, documentLink });

    // Delete the temporary local file after successful upload to Drive
    fs.unlinkSync(localPath);

    res.json({ success: true, message: "Document uploaded to Google Drive and saved" });
  } catch (err) {
    console.error("upload error:", err);
    res.status(500).json({ error: "Document upload failed", detail: err.message });
  }
});




// 🔍 Filtered document (modern) - This will now return Google Drive links
app.get("/documents", async (req, res) => {
  const { uploadedBy } = req.query;
  const sql = uploadedBy
    ? "SELECT * FROM documents WHERE uploaded_by = ?"
    : "SELECT * FROM documents";
  const params = uploadedBy ? [uploadedBy] : [];

  try {
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Error fetching documents" });
  }
});

//Approver updates approval status
app.put("/api/approve/:id", async (req, res) => {
  const { id } = req.params;
  const { approval_status, approved_by } = req.body;
 const istDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));


  try {
    // Update document status in DB
    const [result] = await db.execute(
      `UPDATE documents
       SET approval_status = ?, approved_by = ?, approval_time = ?
       WHERE id = ?`,
      [approval_status, approved_by,istDate, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Fetch document details for email
    const [docRows] = await db.execute("SELECT * FROM documents WHERE id = ?", [id]);
    const doc = docRows[0];

    if (!doc) return res.status(404).json({ message: "Document not found after update" });

    const senderEmail = await getUserEmailByUsername(doc.uploaded_by); // function below
    const reviewerEmail = process.env.REVIEWER_EMAIL;

    if (approval_status === "Approved") {
      // 📩 Notify the Sender
      await sendApprovalNotification({
        toEmails: [senderEmail],
        documentName: doc.document_name,
        uploadedBy: doc.uploaded_by,
        status: "Approved",
        recipientRole: "sender",
      });

      // 📩 Notify the Reviewer separately with a different message
      await sendApprovalNotification({
        toEmails: [reviewerEmail],
        documentName: doc.document_name,
        uploadedBy: doc.uploaded_by,
        status: "Pending Review",
        recipientRole: "reviewer",
      });
    } else {
      await sendApprovalNotification({
        toEmails: [senderEmail],
        documentName: doc.document_name,
        uploadedBy: doc.uploaded_by,
        status: "Unapproved",
      });
    }

    res.json({ message: "Approval status updated and notification sent" });
  } catch (err) {
    console.error("Error updating approval status:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

//reviewer updates table
app.get("/api/approved-documents", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM documents WHERE approval_status = 'Approved' ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch approved documents" });
  }
});

//reviewer status update
app.put("/api/review", async (req, res) => {
  const { uploaded_by, review_status, reviewer } = req.body;
  const review_time = new Date();

  try {
    await db.execute(
      `UPDATE documents
       SET review_status = ?, reviewer = ?, review_time = ?
       WHERE uploaded_by = ? AND approval_status = 'Approved'`,
      [review_status, reviewer, review_time, uploaded_by]
    );

    // 🔔 Get sender's email
    const senderEmail = await getUserEmailByUsername(uploaded_by);
    const approverEmail = process.env.APPROVER_EMAIL; // Ensure this is set in your .env

    const subject =
      review_status === "Approved"
        ? "✅ Document Reviewed & Approved"
        : "❌ Document Reviewed & Rejected";

    const html = `
      <h3>Document reviewed by: ${reviewer}</h3>
      <p><strong>Status:</strong> ${review_status}</p>
      <p><strong>Uploaded By:</strong> ${uploaded_by}</p>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: [senderEmail, approverEmail],
      subject,
      html,
    });

    res.json({ message: "Review status updated and notification sent." });
  } catch (err) {
    console.error("DB Error:", err);
    res.status(500).json({ error: "Failed to update review status." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/checkstatus/homepage.html");
});

// 🚀 Server Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}/homepage.html`);
});
