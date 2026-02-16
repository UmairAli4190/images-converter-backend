import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import { AppError } from "../utils/AppError.js";

const MAX_DIMENSION = 20000;
const SUPPORTED_FORMATS = ["jpg", "jpeg", "png", "webp", "tiff", "avif"];
const ALLOWED_INPUT_FORMATS = [
  "jpeg",
  "jpg",
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
];
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
];

// --------------------
// Safe Delete Helper
// --------------------
async function safeDelete(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return false;
  }
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    console.error(`Failed to delete ${filePath}:`, err.message);
    return false;
  }
}

// --------------------
// Get MIME Type Helper
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
// Validate File Type
// --------------------
function validateFileType(file) {
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mimeType = file.mimetype?.toLowerCase();

  if (
    !ALLOWED_INPUT_FORMATS.includes(ext) &&
    !ALLOWED_MIME_TYPES.includes(mimeType)
  ) {
    throw new AppError(
      `Invalid file type. Allowed formats: ${ALLOWED_INPUT_FORMATS.join(", ")}`,
      400,
      "INVALID_FILE_TYPE",
    );
  }
}

// --------------------
// Validate Format
// --------------------
function validateFormat(format) {
  if (!format || typeof format !== "string") {
    throw new AppError("Format is required", 400, "FORMAT_REQUIRED");
  }

  const normalizedFormat = format.toLowerCase().trim();

  if (!SUPPORTED_FORMATS.includes(normalizedFormat)) {
    throw new AppError(
      `Invalid format. Supported: ${SUPPORTED_FORMATS.join(", ")}`,
      400,
      "INVALID_FORMAT",
    );
  }

  return normalizedFormat;
}

// --------------------
// Validate Image Metadata
// --------------------
async function validateImageMetadata(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new AppError("Invalid image file", 400, "INVALID_IMAGE");
    }

    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      throw new AppError(
        `Input image dimensions exceed maximum (${MAX_DIMENSION}px)`,
        400,
        "INPUT_DIMENSION_TOO_LARGE",
      );
    }

    return metadata;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("Failed to read image metadata", 400, "INVALID_IMAGE");
  }
}

// --------------------
// Create Sharp Pipeline
// --------------------
function createConversionPipeline(inputPath, format) {
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
    default:
      throw new AppError(
        `Unsupported format: ${format}`,
        400,
        "UNSUPPORTED_FORMAT",
      );
  }

  return pipeline;
}

// --------------------
// Single File Convert
// --------------------
async function handleSingleFile(file, format, res) {
  let cleanupDone = false;

  const cleanup = async () => {
    if (!cleanupDone) {
      const isFileDeleted = await safeDelete(file.path);
      if (isFileDeleted) {
        cleanupDone = true;
      }
    }
  };

  try {
    validateFileType(file);
    validateFormat(format);

    await validateImageMetadata(file.path);

    const originalName = path.parse(file.originalname).name;
    const outputFilename = `${originalName}.${format}`;
    const mimeType = getMimeType(format);

    // Set headers before streaming
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputFilename}"`,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const pipeline = createConversionPipeline(file.path, format);

    pipeline.on("error", async (err) => {
      console.error("Sharp pipeline error:", err.message);
      await cleanup();
      if (!res.headersSent) {
        res.status(500).json({
          error: "Image conversion failed",
          code: "CONVERSION_ERROR",
        });
      } else {
        res.end();
      }
    });

    // Cleanup after response finishes
    res.on("finish", cleanup);
    res.on("close", cleanup);
    res.on("error", async (err) => {
      console.error("Response stream error:", err.message);
      await cleanup();
    });

    pipeline.pipe(res);
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// --------------------
// Multiple Files Convert
// --------------------
async function handleMultipleFiles(files, format, res) {
  const filesToCleanup = new Set(files.map((f) => f.path));

  const cleanup = async () => {
    if (filesToCleanup.size > 0) {
      await Promise.allSettled(
        Array.from(filesToCleanup).map((f) => safeDelete(f)),
      );
      filesToCleanup.clear();
    }
  };

  try {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="converted-images.zip"',
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const archive = archiver("zip", { zlib: { level: 6 } });

    let archiveFinalized = false;

    archive.on("error", async (err) => {
      console.error("Archive error:", err.message);
      await cleanup();
      if (!res.headersSent) {
        throw new AppError("ZIP creation failed", 500, "ZIP_ERROR");
      }
    });

    archive.on("end", cleanup);

    // Handle client disconnect
    res.on("close", async () => {
      if (!archiveFinalized) {
        archive.destroy();
        await cleanup();
      }
    });

    archive.pipe(res);

    let processedCount = 0;
    const errors = [];

    for (const file of files) {
      try {
        validateFileType(file);

        await validateImageMetadata(file.path);

        const convertStream = createConversionPipeline(file.path, format);

        convertStream.on("error", (err) => {
          console.error(`Sharp error for ${file.originalname}:`, err.message);
        });

        const passthrough = new PassThrough();

        convertStream.pipe(passthrough);

        // Mark file for cleanup when stream ends
        passthrough.on("end", () => {
          safeDelete(file.path);
          filesToCleanup.delete(file.path);
        });

        passthrough.on("error", () => {
          safeDelete(file.path);
          filesToCleanup.delete(file.path);
        });

        const outputName = `${path.parse(file.originalname).name}.${format}`;

        archive.append(passthrough, { name: outputName });
        processedCount++;
      } catch (err) {
        errors.push({
          file: file.originalname,
          error: err.message,
        });
        console.warn(`Skipped ${file.originalname}:`, err.message);
        await safeDelete(file.path);
        filesToCleanup.delete(file.path);
      }
    }

    // If no files were successfully processed, throw error
    if (processedCount === 0) {
      archive.destroy();
      await cleanup();
      throw new AppError(
        "No files could be processed",
        400,
        "NO_FILES_PROCESSED",
        { errors },
      );
    }

    archiveFinalized = true;
    await archive.finalize();

    // Log any errors that occurred
    if (errors.length > 0) {
      console.warn(
        `Processed ${processedCount}/${files.length} files. Errors:`,
        errors,
      );
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// ======================================================
// MAIN CONVERT CONTROLLER
// Handles single and multiple images automatically
// ======================================================
export const convertController = async (req, res) => {
  try {
    // Validate request - handle both single file and multiple files
    const files = req.files || (req.file ? [req.file] : []);

    if (files.length === 0) {
      throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
    }

    const format = validateFormat(req.body.format);

    // Route to appropriate handler
    if (files.length === 1) {
      await handleSingleFile(files[0], format, res);
    } else {
      await handleMultipleFiles(files, format, res);
    }
  } catch (err) {
    // Clean up any uploaded files on error
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length > 0) {
      await Promise.allSettled(files.map((f) => safeDelete(f.path)));
    }

    // Handle error response
    if (!res.headersSent) {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          ...(err.details && { details: err.details }),
        });
      } else {
        console.error("Unexpected error:", err);
        res.status(500).json({
          error: "Internal server error",
          code: "INTERNAL_ERROR",
        });
      }
    } else {
      // Response already started, just end it
      res.end();
    }
  }
};
