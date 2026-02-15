import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { AppError } from "./utils/AppError.js";
import { asyncWrapper } from "./utils/asyncWrapper.js";
import { convertController } from "./controllers/convertController.js";
import { resizeController } from "./controllers/resizeController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// multer wrapper;
const multerWrapper = (uploadMiddleware) => (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (!err) return next();
    return next(err);
  });
};

// --------------------
// CORS Configuration (Must be first)
// --------------------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.header(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Type, Content-Length",
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------
// Configuration
// --------------------
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SUPPORTED_FORMATS = ["jpg", "jpeg", "png", "webp", "tiff", "avif"];

// --------------------
// Ensure upload directory exists
// --------------------
async function ensureUploadDir() {
  try {
    await fs.access(UPLOAD_DIR);
  } catch {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    console.log("✓ Created uploads directory");
  }
}

// --------------------
// Multer Configuration
// --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/tiff",
    "image/avif",
    "image/gif",
    "image/bmp",
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new AppError(
        "Only image files are allowed, Check the extension",
        400,
        "WRONG_IMAGE_TYPE",
      ),
      false,
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

// --------------------
// Main Conversion Endpoint
// --------------------

// for bulk images
app.post(
  "/convert/bulk",
  multerWrapper(upload.array("images", 20)),
  asyncWrapper(convertController),
);

// for image resize
app.post(
  "/resize/bulk",
  multerWrapper(upload.array("images", 20)),
  asyncWrapper(resizeController),
);

// --------------------
// Health Check
// --------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    formats: SUPPORTED_FORMATS,
  });
});

// --------------------
// 404 Handler
// --------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// --------------------
// Error Handler
// --------------------

// Error Class;
app.use((err, req, res, next) => {
  console.log("GENERAL " + err);
  // multer
  if (err instanceof multer.MulterError) {
    console.log("Error from multer:" + err);
  }
  //appError errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: err.statusCode,
      error: err.message,
    });
  }
  // programming ones
  res.status(500).json({
    status: "error",
    error: "Something went wrong",
  });
});

// --------------------
// Start Server
// --------------------
async function startServer() {
  try {
    await ensureUploadDir();

    app.listen(PORT, () => {
      console.log("\n" + "=".repeat(50));
      console.log("🚀 Image Converter Server Running");
      console.log("=".repeat(50));
      console.log(`📡 URL: http://localhost:${PORT}`);
      console.log(`📁 Uploads: ${UPLOAD_DIR}`);
      console.log(`🎨 Formats: ${SUPPORTED_FORMATS.join(", ")}`);
      console.log(`📦 Max Size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
      console.log("=".repeat(50) + "\n");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// --------------------
// Graceful Shutdown
// --------------------
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n👋 Shutting down gracefully...");
  process.exit(0);
});

// Start the server
startServer();
