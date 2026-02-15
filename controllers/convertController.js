import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import { AppError } from "../utils/AppError.js";

const MAX_DIMENSION = 20000;
const SUPPORTED_FORMATS = ["jpg", "jpeg", "png", "webp", "tiff", "avif"];
const ALLOWED_INPUT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/avif",
  "image/gif",
];

// --------------------
// Safe Delete Helper
// --------------------
async function safeDelete(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Delete error for ${filePath}:`, err.message);
    }
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
// Validate Input File
// --------------------
function validateInputFile(file) {
  if (!file) {
    throw new AppError("No file provided", 400, "FILE_NOT_FOUND");
  }

  const ext = path.extname(file.originalname).toLowerCase().slice(1);
  const mimeType = file.mimetype?.toLowerCase();

  // Check if file type is supported
  const validExtensions = [...SUPPORTED_FORMATS, "gif"];
  if (
    !validExtensions.includes(ext) &&
    !ALLOWED_INPUT_TYPES.includes(mimeType)
  ) {
    throw new AppError(
      `Invalid file type. Supported: ${validExtensions.join(", ")}`,
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
async function validateImageMetadata(filePath, filename) {
  try {
    const metadata = await sharp(filePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new AppError(
        `Invalid or corrupted image: ${filename}`,
        400,
        "INVALID_IMAGE",
      );
    }

    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      throw new AppError(
        `Image dimensions exceed maximum (${MAX_DIMENSION}px): ${filename}`,
        400,
        "IMAGE_TOO_LARGE",
      );
    }

    return metadata;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      `Failed to read image metadata: ${filename}`,
      400,
      "INVALID_IMAGE",
    );
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

// ======================================================
// SINGLE FILE CONVERSION CONTROLLER
// ======================================================
export const singleConvertController = async (req, res) => {
  let cleanupDone = false;
  const inputPath = req.file?.path;

  const cleanup = async () => {
    if (!cleanupDone && inputPath) {
      cleanupDone = true;
      await safeDelete(inputPath);
    }
  };

  try {
    // Validate input
    validateInputFile(req.file);
    const format = validateFormat(req.body.format);

    // Validate image
    await validateImageMetadata(inputPath, req.file.originalname);

    // Prepare output
    const originalName = path.parse(req.file.originalname).name;
    const outputFilename = `${originalName}.${format}`;
    const mimeType = getMimeType(format);

    // Set response headers
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputFilename}"`,
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    // Create conversion pipeline
    const pipeline = createConversionPipeline(inputPath, format);

    // Handle pipeline errors
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

    // Stream to response
    pipeline.pipe(res);
  } catch (err) {
    await cleanup();
    throw err;
  }
};

// ======================================================
// BULK CONVERSION CONTROLLER
// ======================================================
export const bulkConvertController = async (req, res) => {
  const filesToCleanup = new Set(req.files?.map((f) => f.path) || []);

  const cleanup = async () => {
    if (filesToCleanup.size > 0) {
      await Promise.allSettled(
        Array.from(filesToCleanup).map((f) => safeDelete(f)),
      );
      filesToCleanup.clear();
    }
  };

  try {
    // Validate request
    if (!req.files || req.files.length === 0) {
      throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
    }

    const format = validateFormat(req.body.format);

    // Validate all input files before processing
    for (const file of req.files) {
      try {
        validateInputFile(file);
      } catch (err) {
        await cleanup();
        throw err;
      }
    }

    // Set response headers
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="converted-images.zip"',
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    // Create archive
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

    // Process files
    let processedCount = 0;
    const errors = [];

    for (const file of req.files) {
      const inputPath = file.path;

      try {
        // Validate image metadata
        await validateImageMetadata(inputPath, file.originalname);

        // Create conversion pipeline
        const pipeline = createConversionPipeline(inputPath, format);

        // Create passthrough stream
        const stream = new PassThrough();

        pipeline.on("error", (err) => {
          console.error(`Sharp error for ${file.originalname}:`, err.message);
          errors.push({
            file: file.originalname,
            error: "Conversion failed",
          });
        });

        pipeline.pipe(stream);

        // Cleanup after stream ends
        stream.on("end", () => {
          safeDelete(inputPath);
          filesToCleanup.delete(inputPath);
        });

        stream.on("error", (err) => {
          console.error(`Stream error for ${file.originalname}:`, err.message);
          safeDelete(inputPath);
          filesToCleanup.delete(inputPath);
        });

        // Generate output filename
        const outputName = `${path.parse(file.originalname).name}.${format}`;

        // Add to archive
        archive.append(stream, { name: outputName });
        processedCount++;
      } catch (err) {
        errors.push({
          file: file.originalname,
          error: err.message,
        });
        console.warn(`Skipped ${file.originalname}:`, err.message);
        await safeDelete(inputPath);
        filesToCleanup.delete(inputPath);
      }
    }

    // Check if any files were processed
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

    // Finalize archive
    archiveFinalized = true;
    await archive.finalize();

    // Log any errors
    if (errors.length > 0) {
      console.warn(
        `Processed ${processedCount}/${req.files.length} files. Errors:`,
        errors,
      );
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
};

// ======================================================
// ERROR HANDLING MIDDLEWARE WRAPPER (Optional)
// Use this if your framework doesn't have global error handling
// ======================================================
export const wrapController = (controller) => {
  return async (req, res, next) => {
    try {
      await controller(req, res);
    } catch (err) {
      // Cleanup uploaded files
      if (req.file) {
        await safeDelete(req.file.path);
      }
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
};
