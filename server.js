import express from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";
import { AppError } from "./utils/AppError.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// multer wrapper;
const multerWrapper = (uploadMiddleware) => (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (!err) return next();
    // error for wrong file type;
    if (err.type === "WRONG_IMAGE_TYPE") {
      return next(err);
    }

    // Any other error
    return next(new AppError(err.message || "Upload failed", 500));
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
// Cleanup Helper
// --------------------
async function safeDelete(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Ignore errors
  }
}

// --------------------
// Get MIME Type
// --------------------
function getMimeType(format) {
  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    tiff: "image/tiff",
    avif: "image/avif",
  };
  return mimeTypes[format] || "application/octet-stream";
}

// --------------------
// Main Conversion Endpoint
// --------------------

app.post(
  "/convert",
  multerWrapper(upload.single("image")),
  async (req, res) => {
    const startTime = Date.now();
    let inputPath = null;

    try {
      // Validate file exists
      if (!req.file) {
        console.log("❌ No file uploaded");
        return res.status(400).json({
          success: false,
          error: "No image file provided",
        });
      }

      inputPath = req.file.path;
      const format = req.body.format?.toLowerCase()?.trim();

      console.log(
        `📥 Received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(2)} KB)`,
      );
      console.log(`🎯 Target format: ${format}`);

      // Validate format
      if (!format || !SUPPORTED_FORMATS.includes(format)) {
        await safeDelete(inputPath);
        console.log("❌ Invalid format:", format);
        return res.status(400).json({
          success: false,
          error: `Invalid format. Supported: ${SUPPORTED_FORMATS.join(", ")}`,
        });
      }

      // Validate image file
      let metadata;
      try {
        metadata = await sharp(inputPath).metadata();
        console.log(`📐 Dimensions: ${metadata.width}x${metadata.height}`);
      } catch (err) {
        await safeDelete(inputPath);
        console.log("❌ Invalid image file:", err.message);
        return res.status(400).json({
          success: false,
          error: "Invalid or corrupted image file",
        });
      }

      // Check dimensions
      if (metadata.width > 20000 || metadata.height > 20000) {
        await safeDelete(inputPath);
        return res.status(400).json({
          success: false,
          error: "Image dimensions too large (max 20000x20000)",
        });
      }

      // Configure Sharp based on format
      let pipeline = sharp(inputPath);

      switch (format) {
        case "jpg":
        case "jpeg":
          pipeline = pipeline.jpeg({
            quality: 100,
            mozjpeg: true,
            chromaSubsampling: "4:4:4",
          });
          break;

        case "png":
          pipeline = pipeline.png({
            compressionLevel: 6,
            adaptiveFiltering: true,
          });
          break;

        case "webp":
          pipeline = pipeline.webp({
            quality: 100,
            lossless: true,
          });
          break;

        case "tiff":
          pipeline = pipeline.tiff({
            compression: "lzw",
          });
          break;

        case "avif":
          pipeline = pipeline.avif({
            quality: 100,
            lossless: true,
          });
          break;
      }

      console.log("⚙️  Converting...");

      // Convert to buffer
      const buffer = await pipeline.toBuffer();

      console.log(
        `✅ Converted: ${(buffer.length / 1024).toFixed(2)} KB in ${Date.now() - startTime}ms`,
      );

      // Delete input file
      await safeDelete(inputPath);

      // Prepare filename
      const originalName = path.parse(req.file.originalname).name;
      const outputFilename = `${originalName}.${format}`;
      const mimeType = getMimeType(format);

      console.log(`📤 Sending: ${outputFilename}`);

      // Set headers for download
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${outputFilename}"`,
      );
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      // Send buffer
      res.status(200).send(buffer);

      console.log("✓ Response sent successfully\n");
    } catch (error) {
      console.error("❌ Conversion error:", error.message);

      if (inputPath) {
        await safeDelete(inputPath);
      }

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Conversion failed: " + error.message,
        });
      }
    }
  },
);

// for bulk images
app.post("/convert/bulk", upload.array("images", 20), async (req, res) => {
  const startTime = Date.now();
  const format = req.body.format?.toLowerCase()?.trim();

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "No image files provided",
    });
  }

  if (!format || !SUPPORTED_FORMATS.includes(format)) {
    // cleanup uploaded files
    for (const file of req.files) {
      await safeDelete(file.path);
    }

    return res.status(400).json({
      success: false,
      error: `Invalid format. Supported: ${SUPPORTED_FORMATS.join(", ")}`,
    });
  }

  console.log(`📦 Bulk convert: ${req.files.length} files → ${format}`);

  // ZIP response headers
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="converted-images.zip"`,
  );

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", async (err) => {
    console.error("❌ ZIP error:", err.message);
    res.end();

    for (const file of req.files) {
      await safeDelete(file.path);
    }
  });

  archive.pipe(res);

  try {
    for (const file of req.files) {
      let inputPath = file.path;

      try {
        // Validate image
        const metadata = await sharp(inputPath).metadata();

        if (metadata.width > 20000 || metadata.height > 20000) {
          throw new Error("Image dimensions too large");
        }

        // Build pipeline
        let pipeline = sharp(inputPath);

        switch (format) {
          case "jpg":
          case "jpeg":
            pipeline = pipeline.jpeg({
              quality: 100,
              mozjpeg: true,
              chromaSubsampling: "4:4:4",
            });
            break;

          case "png":
            pipeline = pipeline.png({
              compressionLevel: 6,
              adaptiveFiltering: true,
            });
            break;

          case "webp":
            pipeline = pipeline.webp({
              quality: 100,
              lossless: true,
            });
            break;

          case "tiff":
            pipeline = pipeline.tiff({ compression: "lzw" });
            break;

          case "avif":
            pipeline = pipeline.avif({
              quality: 100,
              lossless: true,
            });
            break;
        }

        const buffer = await pipeline.toBuffer();

        const originalName = path.parse(file.originalname).name;
        const outputName = `${originalName}.${format}`;

        archive.append(buffer, { name: outputName });

        console.log(`✅ Added to ZIP: ${outputName}`);
      } catch (err) {
        console.warn(`⚠ Skipped ${file.originalname}: ${err.message}`);
      } finally {
        await safeDelete(inputPath);
      }
    }

    await archive.finalize();

    console.log(
      `📤 ZIP sent (${req.files.length} files) in ${Date.now() - startTime}ms\n`,
    );
  } catch (err) {
    console.error("❌ Bulk conversion failed:", err.message);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Bulk conversion failed",
      });
    }
  }
});

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
