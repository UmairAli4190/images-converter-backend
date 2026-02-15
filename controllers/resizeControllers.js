import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import { AppError } from "../utils/AppError.js";

const MAX_DIMENSION = 20000;
const MAX_OUTPUT_DIMENSION = 10000;

// --------------------
// Safe Delete Helper
// --------------------
async function safeDelete(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    console.log("Delete error:", err.message);
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

  if (width > MAX_OUTPUT_DIMENSION || height > MAX_OUTPUT_DIMENSION) {
    throw new AppError(
      `Maximum allowed dimension is ${MAX_OUTPUT_DIMENSION}px`,
      400,
      "DIMENSION_TOO_LARGE",
    );
  }
}

// ======================================================
// MERGED RESIZE CONTROLLER
// Handles single and multiple images automatically
// ======================================================
export const resizeController = async (req, res) => {
  if (req.files.length == 0) {
    throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
  }
  const files = req.files;
  const widths = req.body.widths ? req.body.widths.map(Number) : [];
  const heights = req.body.heights ? req.body.heights.map(Number) : [];

  // Single file case
  if (files.length == 1) {
    const file = files[0];
    const width = widths[0] || null;
    const height = heights[0] || null;

    validateDimensions(width, height);

    const metadata = await sharp(file.path).metadata();
    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      await safeDelete(file.path);
      throw new AppError(
        "Image dimensions too large",
        400,
        "INPUT_DIMENSION_TOO_LARGE",
      );
    }

    const outputExt = metadata.format || "png";
    const outputName = `${path.parse(file.originalname).name}-resized.${outputExt}`;

    res.setHeader("Content-Type", `image/${outputExt}`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputName}"`,
    );
    res.setHeader("Cache-Control", "no-cache");

    const pipeline = sharp(file.path).resize(width || null, height || null, {
      fit: "inside",
      withoutEnlargement: true,
    });

    pipeline.on("error", async () => {
      await safeDelete(file.path);
      if (!res.headersSent) {
        res.status(500).json({ error: "Resize failed" });
      }
    });

    res.on("end", async () => {
      await safeDelete(file.path);
    });

    return pipeline.pipe(res);
  } else {
    // Multiple files case -> ZIP
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="resized-images.zip"`,
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    archive.on("error", async (err) => {
      console.error("ZIP error:", err.message);
      await Promise.all(files.map((f) => safeDelete(f.path)));
      throw new AppError("ZIP creation failed", 500, "ZIP_ERROR");
    });

    const remainingFiles = new Set(files.map((f) => f.path));

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const width = widths[i] || null;
        const height = heights[i] || null;

        try {
          validateDimensions(width, height);

          const metadata = await sharp(file.path).metadata();
          const outputExt = metadata.format || "png";
          const outputName = `${path.parse(file.originalname).name}-resized.${outputExt}`;

          const pipeline = sharp(file.path).resize(width, height, {
            fit: "inside",
            withoutEnlargement: true,
          });

          const stream = new PassThrough();
          pipeline.pipe(stream);

          stream.on("end", async () => {
            await safeDelete(file.path);
            remainingFiles.delete(file.path);
          });

          stream.on("error", async () => {
            await safeDelete(file.path);
            remainingFiles.delete(file.path);
          });

          archive.append(stream, { name: outputName });
        } catch (err) {
          console.warn(`Skipped ${file.originalname}: ${err.message}`);
          await safeDelete(file.path);
          remainingFiles.delete(file.path);
        }
      }

      await archive.finalize();
    } finally {
      if (remainingFiles.size > 0) {
        await Promise.all(Array.from(remainingFiles).map((f) => safeDelete(f)));
      }
    }
  }
};
