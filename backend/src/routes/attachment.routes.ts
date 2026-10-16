import crypto from "crypto";
import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

const uploadDirectory = path.resolve(process.cwd(), "uploads");

fs.mkdirSync(uploadDirectory, { recursive: true });

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadDirectory);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(
        new Error("Only images, PDFs, and Word documents are allowed.")
      );
    }

    callback(null, true);
  },
});

router.post("/upload", (req, res) => {
  upload.array("attachments", 5)(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        message: error instanceof Error ? error.message : "Upload failed.",
      });
    }

    const files = (req.files ?? []) as Express.Multer.File[];

    return res.status(201).json({
      message: "Files uploaded successfully.",
      files: files.map((file) => ({
        originalName: file.originalname,
        storedName: file.filename,
        filePath: file.path,
        mimeType: file.mimetype,
        fileSize: file.size,
      })),
    });
  });
});

export default router;
