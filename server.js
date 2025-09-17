// server.js
import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import AWS from "aws-sdk";
import multerS3 from "multer-s3";

dotenv.config();

const app = express();

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.use(cors());
app.use(express.json());

/* ====== MySQL pool setup ====== */
const pool = mysql.createPool({
  host: process.env.DB_HOST ,
  user: process.env.DB_USER ,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE ,
  port: Number(process.env.DB_PORT ),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/* ====== Prepare S3 (if configured) ====== */
let useS3 = false;
let s3 = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION && process.env.S3_BUCKET) {
  useS3 = true;
  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });
  s3 = new AWS.S3();
  console.log("S3 enabled:", process.env.S3_BUCKET);
} else {
  console.log("S3 not configured — falling back to local disk uploads.");
}

/* ====== Local disk storage fallback setup ====== */
const uploadDir = path.resolve("./uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

/* ====== Multer setup: either multer-s3 or disk ------- */
let upload;
if (useS3) {
  // Use multer-s3 to write files directly to S3 under uploads/ prefix
  const s3Storage = multerS3({
    s3: s3,
    bucket: process.env.S3_BUCKET,
    acl: process.env.S3_ACL || "private", // consider 'private' and serve via presigned URLs OR 'public-read' if desired
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      // Save in "uploads/" prefix to separate frontend files from user files
      const filename = `uploads/${Date.now()}_${file.originalname}`;
      cb(null, filename);
    },
  });

  upload = multer({
    storage: s3Storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // adjust
  });
} else {
  upload = multer({
    storage: diskStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
  });
}

/* ====== Upload route ====== */
app.post("/api/upload", upload.single("model"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  if (useS3) {
    // For multer-s3, req.file contains location, key
    const fileUrl = req.file.location; // S3 URL if bucket has public access (or CloudFront)
    const s3Key = req.file.key; // e.g., uploads/1694_xxx.stl
    return res.json({
      fileUrl,
      s3Key,
      originalName: req.file.originalname,
      success: true,
      storage: "s3",
    });
  } else {
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    const filePath = req.file.path;
    return res.json({
      fileUrl,
      filePath,
      originalName: req.file.originalname,
      success: true,
      storage: "disk",
    });
  }
});

/* ====== Root check ====== */
app.get("/", (req, res) => res.send("Server is running!"));

/* ====== Order endpoint (unchanged logic, but save s3Key if present) ====== */
app.post("/api/order", async (req, res) => {
  console.log("Order endpoint hit!");
  try {
    const {
      material,
      infill,
      quality,
      weight,
      color,
      name,
      email,
      number,
      fileUrl,
      filePath,
      s3Key,
      save,
    } = req.body;

    const materialCosts = {
      PLA: 0.05,
      ABS: 0.06,
      PETG: 0.07,
      TPU: 0.08,
      ASA: 0.07,
      "PLA Glass": 0.06,
      Engineering: 0.12,
      ePLA: 0.06,
    };

    const qualityMultiplier = {
      "0.2 mm Standard Quality": 1,
      "0.15 mm Medium Quality": 1.2,
      "0.1 mm High Quality": 1.5,
      "0.15 Standard Quality + 0.25 mm Nozzle": 1.1,
      "0.2 mm Standard Quality + 0.6mm Nozzle": 1.05,
    };

    const infillMultiplier = {
      "10%": 0.5,
      "15%": 0.6,
      "20%": 0.8,
      "30%": 1,
      "40%": 1.1,
      "50%": 1.2,
      "60%": 1.3,
      "70%": 1.4,
      "80%": 1.5,
      "90%": 1.6,
    };

    const baseCost = materialCosts[material] ?? 0.05;
    const qualityMult = qualityMultiplier[quality] ?? 1;
    const infillMult = infillMultiplier[infill] ?? 1;

    const usdCost = baseCost * Number(weight || 0) * qualityMult * infillMult;
    const usdToInrRate = Number(process.env.USD_TO_INR_RATE || 83);
    const inrCost = usdCost * usdToInrRate;

    const responsePayload = {
      success: true,
      weight: Number(weight || 0).toFixed(2),
      costUSD: usdCost.toFixed(2),
      costINR: inrCost.toFixed(2),
    };

    if (save) {
      const conn = await pool.getConnection();
      try {
        const insertSql = `
          INSERT INTO orders
            (file_url, file_path, s3_key, material, color, infill, quality, weight, cost_usd, cost_inr, customer_name, email, phone)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const [result] = await conn.execute(insertSql, [
          fileUrl || null,
          filePath || null,
          s3Key || null,
          material || null,
          color || null,
          infill || null,
          quality || null,
          Number(weight) || 0,
          Number(usdCost.toFixed(2)),
          Number(inrCost.toFixed(2)),
          name || null,
          email || null,
          number || null,
        ]);

        responsePayload.orderId = result.insertId;
        responsePayload.message = "Order saved to DB.";
      } finally {
        conn.release();
      }
    }

    res.json(responsePayload);
  } catch (err) {
    console.error("Error in /api/order:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* ====== Serve local uploads only if not using S3 ====== */
if (!useS3) {
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
} else {
  // If using S3, you probably don't want to serve from disk. Optionally, provide a route
  // to generate presigned URLs for private objects if you store S3 objects as private.
  app.get("/api/presign", async (req, res) => {
    // Example: GET /api/presign?key=uploads/123_file.stl
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: "Missing key" });
    try {
      const url = s3.getSignedUrl("getObject", {
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Expires: Number(process.env.PRESIGN_EXPIRES || 60), // seconds
      });
      res.json({ url });
    } catch (err) {
      console.error("Presign error:", err);
      res.status(500).json({ error: "Unable to presign" });
    }
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));




// // server.js
// import express from "express";
// import multer from "multer";
// import cors from "cors";
// import path from "path";
// import fs from "fs";
// import mysql from "mysql2/promise";
// import dotenv from "dotenv";

// dotenv.config();

// const app = express();

// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
//   next();
// });

// app.use(cors());
// app.use(express.json());

// // ====== MySQL pool setup ======
// // Make sure to set DB_HOST, DB_USER, DB_PASSWORD, DB_DATABASE in .env
// const pool = mysql.createPool({
//   host: process.env.DB_HOST || "localhost",
//   user: process.env.DB_USER || "root",
//   password: process.env.DB_PASSWORD || "",
//   database: process.env.DB_DATABASE || "printshop",
//   port:3307,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
// });

// // ====== Upload setup ======
// const uploadDir = path.resolve("./uploads");
// if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// const storage = multer.diskStorage({
//   destination: uploadDir,
//   filename: (req, file, cb) => {
//     cb(null, Date.now() + path.extname(file.originalname));
//   },
// });
// const upload = multer({
//   storage,
//   limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit (adjust if needed)
// });

// // Upload 3D model
// app.post("/api/upload", upload.single("model"), (req, res) => {
//   if (!req.file) return res.status(400).json({ error: "No file uploaded" });
//   const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
//   const filePath = req.file.path;
//   res.json({ fileUrl, filePath, originalName: req.file.originalname });
// });

// app.get("/", (req, res) => res.send("Server is running!"));

// // Place order / calculate cost. If req.body.save is truthy, save order in DB.
// app.post("/api/order", async (req, res) => {
//   console.log("Order endpoint hit!");
//   try {
//     const {
//       material,
//       infill,
//       quality,
//       weight,
//       color,
//       name,
//       email,
//       number,
//       fileUrl,
//       filePath,
//       save,
//     } = req.body;

//     const materialCosts = {
//       PLA: 0.05,
//       ABS: 0.06,
//       PETG: 0.07,
//       TPU: 0.08,
//       ASA: 0.07,
//       "PLA Glass": 0.06,
//       Engineering: 0.12,
//       ePLA: 0.06,
//     };

//     const qualityMultiplier = {
//       "0.2 mm Standard Quality": 1,
//       "0.15 mm Medium Quality": 1.2,
//       "0.1 mm High Quality": 1.5,
//       "0.15 Standard Quality + 0.25 mm Nozzle": 1.1,
//       "0.2 mm Standard Quality + 0.6mm Nozzle": 1.05,
//     };

//     const infillMultiplier = {
//       "10%": 0.5,
//       "15%": 0.6,
//       "20%": 0.8,
//       "30%": 1,
//       "40%": 1.1,
//       "50%": 1.2,
//       "60%": 1.3,
//       "70%": 1.4,
//       "80%": 1.5,
//       "90%": 1.6,
//     };

//     const baseCost = materialCosts[material] ?? 0.05;
//     const qualityMult = qualityMultiplier[quality] ?? 1;
//     const infillMult = infillMultiplier[infill] ?? 1;

//     const usdCost = baseCost * Number(weight || 0) * qualityMult * infillMult;
//     const usdToInrRate = Number(process.env.USD_TO_INR_RATE || 83);
//     const inrCost = usdCost * usdToInrRate;

//     const responsePayload = {
//       success: true,
//       weight: Number(weight || 0).toFixed(2),
//       costUSD: usdCost.toFixed(2),
//       costINR: inrCost.toFixed(2),
//     };

//     if (save) {
//       const conn = await pool.getConnection();
//       try {
//         const insertSql = `
//           INSERT INTO orders
//             (file_url, file_path, material, color, infill, quality, weight, cost_usd, cost_inr, customer_name, email, phone)
//           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `;
//         const [result] = await conn.execute(insertSql, [
//           fileUrl || null,
//           filePath || null,
//           material || null,
//           color || null,
//           infill || null,
//           quality || null,
//           Number(weight) || 0,
//           Number(usdCost.toFixed(2)),
//           Number(inrCost.toFixed(2)),
//           name || null,
//           email || null,
//           number || null,
//         ]);

//         responsePayload.orderId = result.insertId;
//         responsePayload.message = "Order saved to DB.";
//       } finally {
//         conn.release();
//       }
//     }

//     res.json(responsePayload);
//   } catch (err) {
//     console.error("Error in /api/order:", err);
//     res.status(500).json({ success: false, error: "Server error" });
//   }
// });

// // Serve uploaded files
// app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));



 