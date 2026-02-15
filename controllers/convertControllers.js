import sharp from "sharp";
import archiver from "archiver";
import { PassThrough } from "stream";
import path from "path";
import fsPromises from "fs/promises";
import { AppError } from "../utils/AppError.js";
const SUPPORTED_FORMATS = ["jpg", "jpeg", "png", "webp", "tiff", "avif"];
const MAX_DIMENSION = 20000;

// --------------------
// Cleanup Helper
// --------------------
async function safeDelete(filePath) {
  try {
    await fsPromises.unlink(filePath);
  } catch (err) {
    console.log("error from delete func " + err.message);
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

// ======================================================
// MERGED CONVERT CONTROLLER
// Handles single and multiple uploads automatically
// ======================================================
export const convertController = async (req, res) => {
  const format = req.body.format?.toLowerCase()?.trim();

  if (req.files.length == 0) {
    throw new AppError("No image files provided", 400, "FILES_NOT_FOUND");
  }

  if (!format || !SUPPORTED_FORMATS.includes(format)) {
    const filesToDelete = req.files?.length
      ? req.files.map((f) => f.path)
      : req.file
        ? [req.file.path]
        : [];
    await Promise.all(filesToDelete.map((f) => safeDelete(f)));
    throw new AppError(
      `Invalid format. Supported: ${SUPPORTED_FORMATS.join(", ")}`,
      400,
      "INVALID_FORMAT",
    );
  }
  const files = req.files;
  // --- SINGLE IMAGE CASE ---
  if (files.length == 1) {
    console.log(files.length);
    const file = files[0];
    const inputPath = file.path;
    const metadata = await sharp(inputPath).metadata();
    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      await safeDelete(inputPath);
      throw new AppError(
        "Image size is larger than 20000",
        400,
        "LARGE_IMAGE_SIZE_ERROR",
      );
    }
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
        pipeline = pipeline.webp({ quality: 100, lossless: true });
        break;
      case "tiff":
        pipeline = pipeline.tiff({ compression: "lzw" });
        break;
      case "avif":
        pipeline = pipeline.avif({ quality: 100, lossless: true });
        break;
    }

    const outputFilename = `${path.parse(file.originalname).name}.${format}`;
    const mimeType = getMimeType(format);

    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outputFilename}"`,
    );
    res.setHeader("Cache-Control", "no-cache");

    pipeline.on("error", async (err) => {
      await safeDelete(inputPath);
      throw err;
    });

    pipeline.on("end", async () => {
      await safeDelete(inputPath);
    });
    return pipeline.pipe(res);
  } else {
    // --- MULTIPLE IMAGE CASE ---
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="converted-images.zip"`,
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    archive.on("error", async (err) => {
      console.error("ZIP error:", err.message);
      await Promise.all(files.map((file) => safeDelete(file.path)));
      throw new AppError("ZIP creation failed", 500, "ZIP_ERROR");
    });

    const remainingFiles = new Set(files.map((f) => f.path));

    try {
      for (const file of files) {
        const inputPath = file.path;

        try {
          const metadata = await sharp(inputPath).metadata();
          if (
            metadata.width > MAX_DIMENSION ||
            metadata.height > MAX_DIMENSION
          ) {
            console.warn(`Skipped ${file.originalname}: dimensions too large`);
            await safeDelete(inputPath);
            remainingFiles.delete(inputPath);
            continue;
          }

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
              pipeline = pipeline.webp({ quality: 100, lossless: true });
              break;
            case "tiff":
              pipeline = pipeline.tiff({ compression: "lzw" });
              break;
            case "avif":
              pipeline = pipeline.avif({ quality: 100, lossless: true });
              break;
          }

          const outputName = `${path.parse(file.originalname).name}.${format}`;
          const stream = new PassThrough();
          pipeline.pipe(stream);

          stream.on("end", async () => {
            await safeDelete(inputPath);
            remainingFiles.delete(inputPath);
          });

          stream.on("error", async (err) => {
            console.error(
              `Sharp stream error for ${file.originalname}:`,
              err.message,
            );
            await safeDelete(inputPath);
            remainingFiles.delete(inputPath);
          });

          archive.append(stream, { name: outputName });
        } catch (err) {
          console.warn(`⚠ Skipped ${file.originalname}: ${err.message}`);
          await safeDelete(inputPath);
          remainingFiles.delete(inputPath);
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
