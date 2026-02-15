import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import { AppError } from "../utils/AppError.js";

const MAX_DIMENSION = 20000;
const MAX_OUTPUT_DIMENSION = 10000;
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
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Only log if it's not a "file not found" error
    if (err.code !== "ENOENT") {
      console.error(`Delete error for ${filePath}:`, err.message);
    }
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
// Validate Dimensions
// --------------------
function validateDimensions(width, height) {
  if (!width && !height) {
    throw new AppError(
      "Width or height must be provided",
      400,
      "DIMENSION_REQUIRED",
    );
  }

  if (width && (!Number.isInteger(width) || width <= 0)) {
    throw new AppError("Invalid width value", 400, "INVALID_WIDTH");
  }

  if (height && (!Number.isInteger(height) || height <= 0)) {
    throw new AppError("Invalid height value", 400, "INVALID_HEIGHT");
  }

  if (
    (width && width > MAX_OUTPUT_DIMENSION) ||
    (height && height > MAX_OUTPUT_DIMENSION)
  ) {
    throw new AppError(
      `Maximum allowed dimension is ${MAX_OUTPUT_DIMENSION}px`,
      400,
      "DIMENSION_TOO_LARGE",
    );
  }
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
// Single File Resize
// --------------------
async function handleSingleFile(file, width, height, res) {
  let cleanupDone = false;

  const cleanup = async () => {
    if (!cleanupDone) {
      cleanupDone = true;
      await safeDelete(file.path);
    }
  };

  try {
    validateFileType(file);
    validateDimensions(width, height);

    const metadata = await validateImageMetadata(file.path);
    const outputExt = metadata.format || "png";
    const outputName = `${path.parse(file.originalname).name}-resized.${outputExt}`;

    // Set headers before streaming
    res.setHeader("Content-Type", `image/${outputExt}`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputName}"`,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const pipeline = sharp(file.path)
      .resize(width || null, height || null, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .on("error", async (err) => {
        console.error("Sharp pipeline error:", err.message);
        await cleanup();
        if (!res.headersSent) {
          res.status(500).json({
            error: "Image processing failed",
            code: "PROCESSING_ERROR",
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
// Multiple Files Resize
// --------------------
async function handleMultipleFiles(files, widths, heights, res) {
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
      'attachment; filename="resized-images.zip"',
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    const archive = archiver("zip", { zlib: { level: 6 } }); // Level 6 for better performance

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
      const width = widths[i] || null;
      const height = heights[i] || null;

      try {
        validateFileType(file);
        validateDimensions(width, height);

        const metadata = await validateImageMetadata(file.path);
        const outputExt = metadata.format || "png";
        const baseName = path.parse(file.originalname).name;
        const outputName = `${baseName}-resized.${outputExt}`;

        const resizeStream = sharp(file.path)
          .resize(width, height, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .on("error", (err) => {
            console.error(`Sharp error for ${file.originalname}:`, err.message);
          });

        const passthrough = new PassThrough();

        resizeStream.pipe(passthrough);

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
// MAIN RESIZE CONTROLLER
// Handles single and multiple images automatically
// ======================================================
export const resizeController = async (req, res) => {
  try {
    // Validate request
    if (!req.files || req.files.length === 0) {
      throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
    }

    const files = req.files;
    const widths = req.body.widths
      ? req.body.widths.map((w) => (w ? Number(w) : null))
      : [];
    const heights = req.body.heights
      ? req.body.heights.map((h) => (h ? Number(h) : null))
      : [];

    // Validate array lengths match
    if (files.length > 1) {
      if (widths.length > 0 && widths.length !== files.length) {
        throw new AppError(
          "Widths array length must match number of files",
          400,
          "DIMENSION_MISMATCH",
        );
      }
      if (heights.length > 0 && heights.length !== files.length) {
        throw new AppError(
          "Heights array length must match number of files",
          400,
          "DIMENSION_MISMATCH",
        );
      }
    }

    // Route to appropriate handler
    if (files.length === 1) {
      const width = widths[0] || null;
      const height = heights[0] || null;
      await handleSingleFile(files[0], width, height, res);
    } else {
      await handleMultipleFiles(files, widths, heights, res);
    }
  } catch (err) {
    // Clean up any uploaded files on error
    if (req.files && req.files.length > 0) {
      await Promise.allSettled(req.files.map((f) => safeDelete(f.path)));
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
