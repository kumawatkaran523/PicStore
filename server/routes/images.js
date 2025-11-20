const express = require("express");
const multer = require("multer");
const Image = require("../models/Image");
const Folder = require("../models/Folder");
const auth = require("../middleware/auth");
const {
  uploadToCloudinary,
  deleteFromCloudinary,
} = require("../config/cloudinary");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.FILE_SIZE_LIMIT) || 5000000, // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = process.env.ALLOWED_FILE_TYPES?.split(",") || [
      "image/jpeg",
      "image/png",
      "image/gif",
    ];process.env.JWT_SECRET;
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only JPEG, PNG and GIF images are allowed."
        ),
        false
      );
    }
  },
});

//  Get images in a folder
router.get("/", auth, async (req, res) => {
  try {
    const { folder } = req.query;

    let query = { owner: req.user._id };
    
    if (folder) {
      const folderDoc = await Folder.findOne({
        _id: folder,
        owner: req.user._id,
      });

      if (!folderDoc) {
        return res.status(404).json({ message: "Folder not found" });
      }
      query.folder = folder;
    } else {
      query.folder = { $exists: false };
    }

    const images = await Image.find(query)
      .sort({ name: 1 })
      .populate("folder", "name path");

    res.json(images);
  } catch (error) {
    console.error("Get images error:", error);
    res.status(500).json({ message: "Server error while fetching images" });
  }
});

// Search all images for user
router.get("/search", auth, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || !q.trim()) {
      return res.json([]);
    }

    const images = await Image.find({
      owner: req.user._id,
      name: { $regex: q.trim(), $options: "i" },
    })
      .sort({ name: 1 })
      .populate("folder", "name path")
      .limit(50); 

    res.json(images);
  } catch (error) {
    console.error("Search images error:", error);
    res.status(500).json({ message: "Server error while searching images" });
  }
});

// Upload image
router.post("/upload", auth, upload.single("image"), async (req, res) => {
  try {
    const { name, folderId } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Image name is required" });
    }

    if (!folderId) {
      return res.status(400).json({ message: "Folder ID is required" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Image file is required" });
    }

    const folder = await Folder.findOne({
      _id: folderId,
      owner: req.user._id,
    });

    if (!folder) {
      return res.status(404).json({ message: "Folder not found" });
    }

    const existingImage = await Image.findOne({
      owner: req.user._id,
      folder: folderId,
      name: name.trim(),
    });

    if (existingImage) {
      return res
        .status(400)
        .json({ message: "Image with this name already exists in the folder" });
    }

    try {
      const result = await uploadToCloudinary(req.file.buffer, {
        folder: `users/${req.user._id}/images`,
        public_id: `${folderId}_${Date.now()}_${name
          .trim()
          .replace(/[^a-zA-Z0-9]/g, "_")}`,
      });

      const image = new Image({
        name: name.trim(),
        cloudinaryUrl: result.secure_url,
        cloudinaryPublicId: result.public_id,
        folder: folderId,
        owner: req.user._id,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });

      await image.save();
      await image.populate("folder", "name path");

      res.status(201).json(image);
    } catch (uploadError) {
      console.error("Cloudinary upload error:", uploadError);
      return res
        .status(500)
        .json({ message: "Failed to upload image to cloud storage" });
    }
  } catch (error) {
    console.error("Upload image error:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({ message: messages.join(", ") });
    }
    if (error.message.includes("Invalid file type")) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error while uploading image" });
  }
});

// Update image name
router.put("/:id", auth, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Image name is required" });
    }

    const image = await Image.findOne({
      _id: req.params.id,
      owner: req.user._id,
    }).populate("folder", "name path");

    if (!image) {
      return res.status(404).json({ message: "Image not found" });
    }

    const existingImage = await Image.findOne({
      owner: req.user._id,
      folder: image.folder,
      name: name.trim(),
      _id: { $ne: image._id },
    });

    if (existingImage) {
      return res
        .status(400)
        .json({ message: "Image with this name already exists in the folder" });
    }

    image.name = name.trim();
    await image.save();

    res.json(image);
  } catch (error) {
    console.error("Update image error:", error);
    res.status(500).json({ message: "Server error while updating image" });
  }
});

// Delete image
router.delete("/:id", auth, async (req, res) => {
  try {
    const image = await Image.findOne({
      _id: req.params.id,
      owner: req.user._id,
    });

    if (!image) {
      return res.status(404).json({ message: "Image not found" });
    }

    try {
      await deleteFromCloudinary(image.cloudinaryPublicId);
    } catch (cloudinaryError) {
      console.error("Cloudinary delete error:", cloudinaryError);
    }

    await Image.findByIdAndDelete(image._id);

    res.json({ message: "Image deleted successfully" });
  } catch (error) {
    console.error("Delete image error:", error);
    res.status(500).json({ message: "Server error while deleting image" });
  }
});

// Handle multer errors
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ message: "File size too large. Maximum size is 5MB." });
    }
    return res
      .status(400)
      .json({ message: "File upload error: " + error.message });
  }
  next(error);
});

module.exports = router;
