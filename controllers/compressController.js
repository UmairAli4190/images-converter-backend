import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import { AppError } from "../utils/AppError.js";

const MAX_DIMENSION = 20000;
const ALLOWED_FORMATS = ["jpeg", "jpg", "png", "webp", "gif", "tiff", "avif"];
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
// Validate File Type
// --------------------
function validateFileType(file) {
  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mimeType = file.mimetype?.toLowerCase();

  if (
    !ALLOWED_FORMATS.includes(ext) &&
    !ALLOWED_MIME_TYPES.includes(mimeType)
  ) {
    throw new AppError(
      `Invalid file type. Allowed formats: ${ALLOWED_FORMATS.join(", ")}`,
      400,
      "INVALID_FILE_TYPE",
    );
  }
}

// --------------------
// Validate Compression Percent
// --------------------
function validateCompressionPercent(percent) {
  if (percent === undefined || percent === null) {
    throw new AppError(
      "Compression percent is required",
      400,
      "PERCENT_REQUIRED",
    );
  }

  const num = Number(percent);

  if (isNaN(num) || !Number.isFinite(num)) {
    throw new AppError(
      "Compression percent must be a valid number",
      400,
      "INVALID_PERCENT",
    );
  }

  if (num < 1 || num > 100) {
    throw new AppError(
      "Compression percent must be between 1 and 100",
      400,
      "PERCENT_OUT_OF_RANGE",
    );
  }

  return Math.round(num);
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
// Create Compression Pipeline
// percent: 1–100, where 100% = highest quality (least compression)
//                       1%   = lowest quality (most compression)
// --------------------
function createCompressionPipeline(inputPath, format, percent) {
  let pipeline = sharp(inputPath);

  // Sharp's quality settings go from 1 (worst) to 100 (best),
  // so we map percent directly as the quality value.
  const quality = percent;

  switch (format) {
    case "jpg":
    case "jpeg":
      pipeline = pipeline.jpeg({
        quality,
        mozjpeg: true,
      });
      break;
    case "png":
      // PNG is lossless; we control file size via compression level (0–9).
      // Map quality 1–100 to compressionLevel 9–0 (inverse relationship).
      pipeline = pipeline.png({
        compressionLevel: Math.round(9 - (quality / 100) * 9),
        adaptiveFiltering: true,
      });
      break;
    case "webp":
      pipeline = pipeline.webp({
        quality,
        lossless: false,
      });
      break;
    case "tiff":
      // TIFF uses lzw compression; quality controls prediction
      pipeline = pipeline.tiff({
        quality,
        compression: "lzw",
      });
      break;
    case "avif":
      pipeline = pipeline.avif({
        quality,
        lossless: false,
      });
      break;
    case "gif":
      // GIF is palette-based; sharp re-encodes as-is (no quality param)
      pipeline = pipeline.gif();
      break;
    default:
      throw new AppError(
        `Unsupported format for compression: ${format}`,
        400,
        "UNSUPPORTED_FORMAT",
      );
  }

  return pipeline;
}

// --------------------
// Single File Compress
// --------------------
async function handleSingleFile(file, percent, res) {
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

    const metadata = await validateImageMetadata(file.path);

    // Keep original format
    const outputFormat = metadata.format || "jpeg";
    const outputExt = outputFormat === "jpeg" ? "jpg" : outputFormat;
    const originalName = path.parse(file.originalname).name;
    const outputFilename = `${originalName}-compressed.${outputExt}`;

    // Set headers before streaming
    res.setHeader("Content-Type", `image/${outputFormat}`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputFilename}"`,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const pipeline = createCompressionPipeline(
      file.path,
      outputFormat,
      percent,
    );

    pipeline.on("error", async (err) => {
      console.error("Sharp pipeline error:", err.message);
      await cleanup();
      if (!res.headersSent) {
        res.status(500).json({
          error: "Image compression failed",
          code: "COMPRESSION_ERROR",
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
// Multiple Files Compress
// --------------------
async function handleMultipleFiles(files, percent, res) {
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
      'attachment; filename="compressed-images.zip"',
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

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        validateFileType(file);

        const metadata = await validateImageMetadata(file.path);

        const outputFormat = metadata.format || "jpeg";
        const outputExt = outputFormat === "jpeg" ? "jpg" : outputFormat;
        const baseName = path.parse(file.originalname).name;
        const outputName = `${baseName}-compressed.${outputExt}`;

        const compressStream = createCompressionPipeline(
          file.path,
          outputFormat,
          percent,
        );

        compressStream.on("error", (err) => {
          console.error(`Sharp error for ${file.originalname}:`, err.message);
        });

        const passthrough = new PassThrough();

        compressStream.pipe(passthrough);

        // Mark file for cleanup when stream ends
        passthrough.on("end", () => {
          safeDelete(file.path);
          filesToCleanup.delete(file.path);
        });

        passthrough.on("error", () => {
          safeDelete(file.path);
          filesToCleanup.delete(file.path);
        });

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
// MAIN COMPRESS CONTROLLER
// Handles single and multiple images automatically.
//
// Expected request body:
//   images  - file(s) via multipart/form-data
//   percent - a single number (1–100) applied to all files
// ======================================================
export const compressController = async (req, res) => {
  try {
    // Validate request - handle both single file and multiple files
    const files = req.files || (req.file ? [req.file] : []);

    if (files.length === 0) {
      throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
    }

    const percent = validateCompressionPercent(req.body.quality);
    // Route to appropriate handler
    if (files.length === 1) {
      await handleSingleFile(files[0], percent, res);
    } else {
      await handleMultipleFiles(files, percent, res);
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
